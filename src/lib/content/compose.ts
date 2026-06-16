import { createContent, createPost } from "./service";
import type { AutoReplyInput } from "./schemas";

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;
const VIDEO_TYPES = new Set(["reel", "short", "video", "story"]);

export interface ComposePostInput {
  platform: string;
  description?: string;
  hashtags?: string;
  // COMPOSE2: per-post automation set at authoring time (null/absent = inherit the channel default).
  firstComment?: string | null;
  autoStory?: boolean | null;
  autoReply?: AutoReplyInput | null;
}

export interface ComposeInput {
  brand: string; // brand key → content.profile (drives channel resolution at publish time)
  title: string;
  contentType?: string;
  mediaUrl: string;
  coverUrl?: string;
  baseDescription?: string;
  baseHashtags?: string;
  posts: ComposePostInput[];
}

/** Whether the single media asset is a video (→ video_url) or an image (→ media_url). */
export function isVideoMedia(mediaUrl: string, contentType?: string): boolean {
  if (contentType && VIDEO_TYPES.has(contentType.trim().toLowerCase())) return true;
  return VIDEO_RE.test(mediaUrl);
}

/**
 * Author a new content item + one editorial post per selected platform, in a workspace. Authoring
 * only — no publish. Produces rows identical to the importer's, so the publish cockpit resolves each
 * platform's channel from the brand with zero extra wiring.
 */
export async function composeContent(input: ComposeInput, workspaceId: string): Promise<{ contentId: string; postIds: string[] }> {
  if (!input.brand?.trim()) throw new Error("brand is required");
  if (!input.title?.trim()) throw new Error("title is required");
  if (!input.mediaUrl?.trim()) throw new Error("mediaUrl is required");
  if (!input.posts?.length) throw new Error("at least one platform is required");

  const video = isVideoMedia(input.mediaUrl, input.contentType);

  const content = await createContent(
    {
      title: input.title.trim(),
      contentType: input.contentType,
      profile: input.brand.trim(),
      baseDescription: input.baseDescription,
      baseHashtags: input.baseHashtags,
      mediaUrls: [input.mediaUrl, ...(input.coverUrl ? [input.coverUrl] : [])],
      status: "draft",
    },
    workspaceId,
  );

  const postIds: string[] = [];
  for (const p of input.posts) {
    const post = await createPost(
      {
        contentId: content.id,
        platform: p.platform,
        description: p.description?.trim() || input.baseDescription,
        hashtags: p.hashtags?.trim() || input.baseHashtags,
        ...(video ? { videoUrl: input.mediaUrl } : { mediaUrl: input.mediaUrl }),
        coverUrl: input.coverUrl,
        status: "planned",
        // COMPOSE2: per-post automation. Omit when absent so the column stays NULL (inherit default);
        // pass an explicit value (incl. false / empty string) when the author set one.
        ...(p.firstComment != null ? { firstComment: p.firstComment } : {}),
        ...(p.autoStory != null ? { autoStory: p.autoStory } : {}),
        ...(p.autoReply != null ? { autoReply: p.autoReply } : {}),
      },
      workspaceId,
    );
    postIds.push(post.id);
  }
  return { contentId: content.id, postIds };
}
