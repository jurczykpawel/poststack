import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts, content as contentTable } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { resolveChannelForBrandPlatform } from "@/lib/brands/resolve";
import { publishPost, type PublishPostDeps } from "./publish";

export type ResolveResult = { channelId: string; label: string } | { reason: string };

/**
 * Resolve the channel an editorial post should publish to, from its content's brand
 * (`content.profile`) and the post's platform — workspace-scoped. This is what makes the cockpit
 * "channel already chosen". Returns a human reason when it can't (no brand / unmapped slot).
 */
export async function resolveBrandChannelForPost(postId: string, workspaceId: string): Promise<ResolveResult> {
  const post = await db.query.posts.findFirst({ where: and(eq(posts.id, postId), eq(posts.workspace_id, workspaceId)) });
  if (!post) return { reason: "Post not found" };
  if (!post.content_id) return { reason: "Post is not linked to content" };
  const content = await db.query.content.findFirst({ where: and(eq(contentTable.id, post.content_id), eq(contentTable.workspace_id, workspaceId)) });
  const brandKey = content?.profile?.trim();
  if (!brandKey) return { reason: "Content has no brand — set its profile" };
  const ch = await resolveChannelForBrandPlatform(workspaceId, brandKey, post.platform);
  if (!ch) return { reason: `No ${post.platform} channel mapped for ${brandKey}` };
  return { channelId: ch.id, label: ch.label };
}

export type PostPublishResult =
  | { postId: string; ok: true; deliveryId: string }
  | { postId: string; ok: false; reason: string };

/**
 * Publish (or schedule) many editorial posts, each to its own brand-resolved channel, in a workspace.
 * Best-effort: one post's failure never blocks the rest — each is reported.
 */
export async function publishPosts(
  postIds: string[],
  when: "now" | string,
  workspaceId: string,
  deps?: PublishPostDeps,
): Promise<PostPublishResult[]> {
  const out: PostPublishResult[] = [];
  for (const postId of postIds) {
    const target = await resolveBrandChannelForPost(postId, workspaceId);
    if ("reason" in target) {
      out.push({ postId, ok: false, reason: target.reason });
      continue;
    }
    try {
      const { delivery } = deps
        ? await publishPost({ postId, channelId: target.channelId, when }, workspaceId, deps)
        : await publishPost({ postId, channelId: target.channelId, when }, workspaceId);
      out.push({ postId, ok: true, deliveryId: delivery.id });
    } catch (err) {
      out.push({ postId, ok: false, reason: err instanceof ApiError ? err.message : "publish failed" });
    }
  }
  return out;
}
