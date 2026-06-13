import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { content as contentTable, posts } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { encodeCursor, decodeCursor } from "@/lib/api/pagination";
import { parseSort } from "@/lib/api/sort";
import type { ContentWritable, PostWritable } from "./schemas";

export type ContentRow = typeof contentTable.$inferSelect;
export type PostRow = typeof posts.$inferSelect;

interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

const CONTENT_MAP: Record<string, string> = {
  title: "title", contentType: "content_type", script: "script", mediaUrls: "media_urls",
  profile: "profile", status: "status", evergreen: "evergreen", republishInterval: "republish_interval",
  lastPublishedAt: "last_published_at", approvedAt: "approved_at", approvedBy: "approved_by",
  leadMagnet: "lead_magnet", notes: "notes", baseDescription: "base_description",
  baseHashtags: "base_hashtags", ideaSource: "idea_source", language: "language", sourceRef: "source_ref",
};
const CONTENT_DATES = new Set(["lastPublishedAt", "approvedAt"]);

const POST_MAP: Record<string, string> = {
  contentId: "content_id", platform: "platform", description: "description", hashtags: "hashtags",
  ctaType: "cta_type", scheduledDate: "scheduled_date", status: "status", postizId: "postiz_id",
  publishedUrl: "published_url", publishedAt: "published_at", notes: "notes", language: "language",
  mediaUrl: "media_url", videoUrl: "video_url", coverUrl: "cover_url", mediaUrls: "media_urls",
  assetStatus: "asset_status", assetNotes: "asset_notes", sourceRef: "source_ref",
};
const POST_DATES = new Set(["scheduledDate", "publishedAt"]);

function mapFields(input: Record<string, unknown>, map: Record<string, string>, dates: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [camel, col] of Object.entries(map)) {
    const v = input[camel];
    if (v !== undefined) out[col] = dates.has(camel) && typeof v === "string" ? new Date(v) : v;
  }
  return out;
}

/** Keyset page on (created_at, id), millisecond-truncated to match the cursor's JS-Date precision. */
function keyset(args: { cursor?: string; sort?: string; createdAt: PgColumn; id: PgColumn }) {
  const dir = parseSort(args.sort, ["created_at"])[0]?.dir ?? "desc";
  const cur = args.cursor ? decodeCursor(args.cursor) : null;
  if (args.cursor && !cur) throw new ApiError("invalid_request", "Invalid cursor", 400);
  const ts = sql`date_trunc('milliseconds', ${args.createdAt})`;
  const where: SQL | undefined = cur
    ? dir === "desc"
      ? sql`(${ts}, ${args.id}) < (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`
      : sql`(${ts}, ${args.id}) > (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`
    : undefined;
  const orderBy = dir === "desc" ? [sql`${ts} desc`, desc(args.id)] : [sql`${ts} asc`, asc(args.id)];
  return { where, orderBy };
}

function page<T extends { created_at: Date; id: string }>(rows: T[], limit: number): ListResult<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null,
  };
}

// ── content (workspace-scoped) ──────────────────────────────────────────────────

export async function createContent(input: ContentWritable, workspaceId: string, idempotencyKey?: string): Promise<ContentRow> {
  const values = mapFields(input, CONTENT_MAP, CONTENT_DATES) as typeof contentTable.$inferInsert;
  values.workspace_id = workspaceId;
  if (idempotencyKey) values.idempotency_key = idempotencyKey;
  // PSA43: DO NOTHING on any unique conflict (idempotency_key OR source_ref, per workspace), then re-select.
  const [row] = await db.insert(contentTable).values(values).onConflictDoNothing().returning();
  if (row) return row;
  if (idempotencyKey) {
    const r = await db.query.content.findFirst({ where: and(eq(contentTable.workspace_id, workspaceId), eq(contentTable.idempotency_key, idempotencyKey)) });
    if (r) return r;
  }
  if (values.source_ref) {
    const r = await db.query.content.findFirst({ where: and(eq(contentTable.workspace_id, workspaceId), eq(contentTable.source_ref, values.source_ref)) });
    if (r) return r;
  }
  throw new ApiError("conflict", "Content already exists but could not be resolved", 409);
}

export async function listContent(args: {
  workspaceId: string;
  limit: number;
  cursor?: string;
  sort?: string;
  status?: string;
  profile?: string;
  contentType?: string;
  q?: string;
}): Promise<ListResult<ContentRow>> {
  const ks = keyset({ cursor: args.cursor, sort: args.sort, createdAt: contentTable.created_at, id: contentTable.id });
  const filters = [
    eq(contentTable.workspace_id, args.workspaceId),
    ks.where,
    args.status ? eq(contentTable.status, args.status) : undefined,
    args.profile ? eq(contentTable.profile, args.profile) : undefined,
    args.contentType ? eq(contentTable.content_type, args.contentType) : undefined,
    args.q ? ilike(contentTable.title, `%${args.q}%`) : undefined,
  ].filter((x): x is NonNullable<typeof x> => x !== undefined);
  const rows = await db.query.content.findMany({ where: and(...filters), orderBy: ks.orderBy, limit: args.limit + 1 });
  return page(rows, args.limit);
}

export async function getContent(id: string, workspaceId: string): Promise<(ContentRow & { posts: PostRow[] }) | undefined> {
  return db.query.content.findFirst({
    where: and(eq(contentTable.id, id), eq(contentTable.workspace_id, workspaceId)),
    with: { posts: true },
  });
}

export async function patchContent(id: string, workspaceId: string, patch: Partial<ContentWritable>): Promise<ContentRow | undefined> {
  const values = mapFields(patch, CONTENT_MAP, CONTENT_DATES);
  const [row] = await db
    .update(contentTable)
    .set({ ...values, updated_at: new Date() })
    .where(and(eq(contentTable.id, id), eq(contentTable.workspace_id, workspaceId)))
    .returning();
  return row;
}

export async function deleteContent(id: string, workspaceId: string): Promise<boolean> {
  const rows = await db.delete(contentTable).where(and(eq(contentTable.id, id), eq(contentTable.workspace_id, workspaceId))).returning({ id: contentTable.id });
  return rows.length > 0;
}

// ── editorial posts (workspace-scoped) ────────────────────────────────────────────

export async function createPost(input: PostWritable, workspaceId: string, idempotencyKey?: string): Promise<PostRow> {
  const values = mapFields(input, POST_MAP, POST_DATES) as typeof posts.$inferInsert;
  values.workspace_id = workspaceId;
  if (idempotencyKey) values.idempotency_key = idempotencyKey;
  const [row] = await db.insert(posts).values(values).onConflictDoNothing().returning();
  if (row) return row;
  if (idempotencyKey) {
    const r = await db.query.posts.findFirst({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.idempotency_key, idempotencyKey)) });
    if (r) return r;
  }
  if (values.source_ref) {
    const r = await db.query.posts.findFirst({ where: and(eq(posts.workspace_id, workspaceId), eq(posts.source_ref, values.source_ref)) });
    if (r) return r;
  }
  throw new ApiError("conflict", "Post already exists but could not be resolved", 409);
}

export async function listPosts(args: {
  workspaceId: string;
  limit: number;
  cursor?: string;
  sort?: string;
  contentId?: string;
  platform?: string;
  status?: string;
  q?: string;
}): Promise<ListResult<PostRow>> {
  const ks = keyset({ cursor: args.cursor, sort: args.sort, createdAt: posts.created_at, id: posts.id });
  const filters = [
    eq(posts.workspace_id, args.workspaceId),
    ks.where,
    args.contentId ? eq(posts.content_id, args.contentId) : undefined,
    args.platform ? eq(posts.platform, args.platform) : undefined,
    args.status ? eq(posts.status, args.status) : undefined,
    args.q ? ilike(posts.description, `%${args.q}%`) : undefined,
  ].filter((x): x is NonNullable<typeof x> => x !== undefined);
  const rows = await db.query.posts.findMany({ where: and(...filters), orderBy: ks.orderBy, limit: args.limit + 1 });
  return page(rows, args.limit);
}

export async function getPost(id: string, workspaceId: string): Promise<PostRow | undefined> {
  return db.query.posts.findFirst({ where: and(eq(posts.id, id), eq(posts.workspace_id, workspaceId)) });
}

export async function patchPost(id: string, workspaceId: string, patch: Partial<PostWritable>): Promise<PostRow | undefined> {
  const values = mapFields(patch, POST_MAP, POST_DATES);
  const [row] = await db
    .update(posts)
    .set({ ...values, updated_at: new Date() })
    .where(and(eq(posts.id, id), eq(posts.workspace_id, workspaceId)))
    .returning();
  return row;
}

export async function deletePost(id: string, workspaceId: string): Promise<boolean> {
  const rows = await db.delete(posts).where(and(eq(posts.id, id), eq(posts.workspace_id, workspaceId))).returning({ id: posts.id });
  return rows.length > 0;
}
