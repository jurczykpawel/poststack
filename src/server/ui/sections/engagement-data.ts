import { and, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, content, postReactions, postReactionStats, posts } from "@/db/schema";
import { containsPattern, type ListPage } from "@/lib/list-page";

export interface PostKey {
  channelId: string;
  postId: string;
}

export interface PostFacts {
  total: number;
  lastAt: Date;
  byType: Array<{ type: string; n: number }>;
}

export interface LinkedPost {
  text: string | null;
  url: string | null;
  contentId: string | null;
}

interface PageCursor extends PostKey {
  at: string;
}

const encode = (c: PageCursor) => Buffer.from(JSON.stringify([c.at, c.channelId, c.postId])).toString("base64url");

function decode(token: string | undefined): PageCursor | null {
  if (!token) return null;
  try {
    const [at, channelId, postId] = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown[];
    const valid = typeof at === "string" && !Number.isNaN(Date.parse(at)) && typeof channelId === "string"
      && /^[0-9a-f-]{36}$/i.test(channelId) && typeof postId === "string";
    return valid ? { at, channelId, postId } : null;
  } catch {
    return null;
  }
}

/** A row in the post view: one post on one channel, live reactions and compacted totals merged. */
export const postRowId = (k: PostKey) => `${k.channelId}~${k.postId}`;

export function parsePostRowId(id: string): PostKey | null {
  const cut = id.indexOf("~");
  if (cut < 0 || !/^[0-9a-f-]{36}$/i.test(id.slice(0, cut))) return null;
  return { channelId: id.slice(0, cut), postId: id.slice(cut + 1) };
}

// Reactions older than the retention window survive only as totals in post_reaction_stats, so every
// read covers both tables. Publishing keeps the bare video id for a Facebook video while the webhook
// says "<page>_<post>", hence the second form in the join to our posts.
const matchesPost = (postId: SQL) => sql`${posts.platform_post_id} IN (${postId}, split_part(${postId}, '_', 2))`;

function listedCte(workspaceId: string, channelIds: string[] | null, q: string): SQL {
  const live = and(eq(postReactions.workspace_id, workspaceId), channelIds ? inArray(postReactions.channel_id, channelIds) : undefined);
  const stats = and(eq(postReactionStats.workspace_id, workspaceId), channelIds ? inArray(postReactionStats.channel_id, channelIds) : undefined);
  let search = sql``;
  if (q) {
    const pat = containsPattern(q);
    search = sql`WHERE m.post_id ILIKE ${pat}
      OR m.channel_id IN (SELECT ${channels.id} FROM ${channels} WHERE ${channels.workspace_id} = ${workspaceId} AND (${channels.display_name} ILIKE ${pat} OR ${channels.username} ILIKE ${pat}))
      OR EXISTS (SELECT 1 FROM ${posts} LEFT JOIN ${content} ON ${content.id} = ${posts.content_id}
        WHERE ${posts.workspace_id} = ${workspaceId} AND ${matchesPost(sql`m.post_id`)}
          AND (${posts.description} ILIKE ${pat} OR ${posts.title} ILIKE ${pat} OR ${content.title} ILIKE ${pat}))`;
  }
  return sql`WITH merged AS (
      SELECT ${postReactions.channel_id} AS channel_id, ${postReactions.post_id} AS post_id, max(${postReactions.created_at}) AS last_at
      FROM ${postReactions} WHERE ${live} GROUP BY 1, 2
      UNION ALL
      SELECT ${postReactionStats.channel_id}, ${postReactionStats.post_id}, max(${postReactionStats.last_reacted_at})
      FROM ${postReactionStats} WHERE ${stats} GROUP BY 1, 2
    ), listed AS (
      SELECT m.channel_id, m.post_id, max(m.last_at) AS last_at FROM merged m ${search} GROUP BY 1, 2
    )`;
}

export async function countPosts(workspaceId: string, channelIds: string[] | null): Promise<number> {
  if (channelIds?.length === 0) return 0;
  const { rows } = await db.execute<{ n: number }>(sql`${listedCte(workspaceId, channelIds, "")} SELECT count(*)::int AS n FROM listed`);
  return rows[0]?.n ?? 0;
}

const EMPTY: ListPage<PostKey> = { rows: [], start: 0, end: 0, total: 0, older: null, newer: null };

/** Keyset page over posts by latest reaction: the grouping and the page both happen in SQL. */
export async function postPage(a: {
  workspaceId: string; channelIds: string[] | null; q: string; limit: number; after?: string; before?: string;
}): Promise<ListPage<PostKey>> {
  if (a.channelIds?.length === 0) return EMPTY;
  const cte = listedCte(a.workspaceId, a.channelIds, a.q);
  const tuple = (op: "<" | ">", c: PageCursor) => sql`(last_at, channel_id, post_id) ${sql.raw(op)} (${c.at}::timestamp, ${c.channelId}::uuid, ${c.postId}::text)`;
  const fetch = async (where: SQL | undefined, ascending: boolean, limit: number): Promise<PageCursor[]> => {
    const dir = sql.raw(ascending ? "ASC" : "DESC");
    const { rows } = await db.execute<{ channel_id: string; post_id: string; at: string }>(sql`${cte}
      SELECT channel_id, post_id, to_char(last_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM listed
      ${where ? sql`WHERE ${where}` : sql``} ORDER BY last_at ${dir}, channel_id ${dir}, post_id ${dir} LIMIT ${limit}`);
    return rows.map((r) => ({ at: r.at, channelId: r.channel_id, postId: r.post_id }));
  };

  const take = a.limit + 1;
  const after = decode(a.after);
  const before = after ? null : decode(a.before);
  let rows: PageCursor[];
  let hasOlder: boolean;
  const ascending = before ? await fetch(tuple(">", before), true, take) : [];
  if (ascending.length > a.limit) {
    rows = ascending.slice(0, a.limit).reverse();
    hasOlder = true;
  } else {
    rows = after ? await fetch(tuple("<", after), false, take) : await fetch(undefined, false, take);
    // Everything older was compacted away or unreacted since the link was made.
    if (after && rows.length === 0) rows = await fetch(undefined, false, take);
    hasOlder = rows.length > a.limit;
  }

  const page = rows.slice(0, a.limit);
  const top = page[0];
  const bottom = page[page.length - 1];
  const { rows: counts } = await db.execute<{ total: number; newer: number }>(sql`${cte}
    SELECT count(*)::int AS total, ${top ? sql`count(*) FILTER (WHERE ${tuple(">", top)})::int` : sql`0`} AS newer FROM listed`);
  const newer = counts[0]?.newer ?? 0;
  return {
    rows: page.map(({ channelId, postId }) => ({ channelId, postId })),
    start: page.length ? newer + 1 : 0,
    end: newer + page.length,
    total: counts[0]?.total ?? 0,
    older: hasOlder && bottom ? encode(bottom) : null,
    newer: newer > 0 && top ? encode(top) : null,
  };
}

/** Totals, per-type counts and latest reaction for the given posts, live ∪ compacted. */
export async function postFacts(workspaceId: string, keys: PostKey[]): Promise<Map<string, PostFacts>> {
  const out = new Map<string, PostFacts>();
  if (!keys.length) return out;
  const ids = [...new Set(keys.map((k) => k.postId))];
  const { rows } = await db.execute<{ channel_id: string; post_id: string; type: string; n: number; at: string }>(sql`
    SELECT channel_id, post_id, type, sum(n)::int AS n, to_char(max(last_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM (
      SELECT ${postReactions.channel_id} AS channel_id, ${postReactions.post_id} AS post_id, ${postReactions.reaction_type} AS type, count(*) AS n, max(${postReactions.created_at}) AS last_at
      FROM ${postReactions} WHERE ${and(eq(postReactions.workspace_id, workspaceId), inArray(postReactions.post_id, ids))} GROUP BY 1, 2, 3
      UNION ALL
      SELECT ${postReactionStats.channel_id}, ${postReactionStats.post_id}, ${postReactionStats.reaction_type}, ${postReactionStats.count}, ${postReactionStats.last_reacted_at}
      FROM ${postReactionStats} WHERE ${and(eq(postReactionStats.workspace_id, workspaceId), inArray(postReactionStats.post_id, ids))}
    ) u GROUP BY 1, 2, 3`);
  for (const r of rows) {
    const id = postRowId({ channelId: r.channel_id, postId: r.post_id });
    const f = out.get(id) ?? { total: 0, lastAt: new Date(r.at), byType: [] };
    f.total += r.n;
    if (new Date(r.at) > f.lastAt) f.lastAt = new Date(r.at);
    f.byType.push({ type: r.type, n: r.n });
    out.set(id, f);
  }
  for (const f of out.values()) f.byType.sort((a, b) => b.n - a.n);
  return out;
}

/** What we know from our own publishing about these platform post ids, keyed by the id asked for. */
export async function linkedPosts(workspaceId: string, postIds: string[]): Promise<Map<string, LinkedPost>> {
  const out = new Map<string, LinkedPost>();
  if (!postIds.length) return out;
  const bare = (id: string) => id.split("_")[1] ?? id;
  const rows = await db
    .select({ platformId: posts.platform_post_id, description: posts.description, title: posts.title, url: posts.published_url, contentId: posts.content_id, contentTitle: content.title })
    .from(posts)
    .leftJoin(content, eq(content.id, posts.content_id))
    .where(and(eq(posts.workspace_id, workspaceId), inArray(posts.platform_post_id, [...new Set(postIds.flatMap((id) => [id, bare(id)]))])))
    .orderBy(desc(posts.published_at), desc(posts.id));
  const byId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.platformId && !byId.has(r.platformId)) byId.set(r.platformId, r);
  for (const id of postIds) {
    const r = byId.get(id) ?? byId.get(bare(id));
    if (r) out.set(id, { text: r.description || r.title || r.contentTitle || null, url: r.url, contentId: r.contentId });
  }
  return out;
}

export async function recentReactors(workspaceId: string, k: PostKey, limit: number): Promise<string[]> {
  const rows = await db
    .select({ name: postReactions.reactor_name })
    .from(postReactions)
    .where(and(
      eq(postReactions.workspace_id, workspaceId), eq(postReactions.channel_id, k.channelId), eq(postReactions.post_id, k.postId),
      isNotNull(postReactions.reactor_name),
    ))
    .orderBy(desc(postReactions.created_at))
    .limit(limit);
  return rows.map((r) => r.name!);
}
