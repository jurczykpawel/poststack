import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts, content, channels } from "@/db/schema";
import { buildCaption } from "@/lib/content/publish";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

/**
 * ADCTX1: the parent post's caption for a comment, when the post was published through PostStack
 * (indexed workspace_id+platform_post_id join, mirrors the same lookup already used for the inbox
 * thread's post-title label). Falls back to the content's editorial title when the post has no
 * caption text of its own. A post published outside PostStack (no local row) resolves to
 * `undefined` here — see ADCTX2 for the live Graph API fallback.
 */
export async function resolveLocalPostCaption(
  workspaceId: string,
  platformPostId: string | undefined,
): Promise<string | undefined> {
  if (!platformPostId) return undefined;
  const [row] = await db
    .select({ description: posts.description, hashtags: posts.hashtags, title: content.title })
    .from(posts)
    .innerJoin(content, eq(posts.content_id, content.id))
    .where(and(eq(posts.workspace_id, workspaceId), eq(posts.platform_post_id, platformPostId)))
    .limit(1);
  if (!row) return undefined;
  return buildCaption(row.description, row.hashtags) ?? row.title;
}

/**
 * ADCTX2: best-effort live fetch of a post's caption/message from the platform API, for a post that
 * has no local PostStack record (published outside PostStack — {@link resolveLocalPostCaption}
 * missed). Never throws: a missing channel, an unsupported platform, or any fetch failure (bad
 * token, rate limit, timeout) all resolve to `undefined` — a failed context enrichment must not
 * block draft generation, which still runs from the bare comment text.
 */
async function fetchPostCaptionLive(channelId: string, platformPostId: string): Promise<string | undefined> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { platform: true, token_encrypted: true },
  });
  if (!channel) return undefined;
  const provider = getProvider(channel.platform);
  if (!provider.getPostText) return undefined;
  try {
    const text = await provider.getPostText(decryptTokens(channel.token_encrypted), platformPostId);
    return text?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ADCTX1+ADCTX2 combined: the parent post's caption for a comment, local PostStack record first,
 * then a live platform-API fetch when the post was published outside PostStack. This is what the
 * AI-draft enqueue sites call.
 */
export async function resolvePostContext(
  workspaceId: string,
  channelId: string,
  platformPostId: string | undefined,
): Promise<string | undefined> {
  if (!platformPostId) return undefined;
  const local = await resolveLocalPostCaption(workspaceId, platformPostId);
  if (local) return local;
  return fetchPostCaptionLive(channelId, platformPostId);
}
