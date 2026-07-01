import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts, content } from "@/db/schema";
import { buildCaption } from "@/lib/content/publish";

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
