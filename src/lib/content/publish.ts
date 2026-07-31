import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { posts, content as contentTable, channels, deliveries, brands } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { createDelivery } from "@/lib/deliveries/service";
import { channelMatchesPlatform } from "@/lib/channels/platform-match";
import { registerByUrl } from "@/lib/media/service";
import { getStorage } from "@/lib/storage";
import { defaultProbe } from "@/lib/media/probe";
import type { PublishRequest } from "@/lib/providers/types";
import { getProviderForPlatform } from "@/lib/providers";
import { disclosureFlag } from "@/lib/ai-disclosure/mapping";
import { resolveDisclosure, type ResolvedDisclosure } from "@/lib/ai-disclosure/resolve";

/** description + hashtags → a single caption (blank-line separated). */
export function buildCaption(description?: string | null, hashtags?: string | null): string | undefined {
  const parts = [description?.trim(), hashtags?.trim()].filter((s): s is string => !!s);
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * AIDISC1: put the in-content disclosure note at the TOP of the caption, on its own line.
 *
 * Leading, not trailing, on purpose. The Commission's Code of Practice wants the label "immediately
 * perceivable without requiring user interaction" and, for text, near the top — and Instagram/TikTok
 * collapse long captions behind a "more" tap, so a note appended after the hashtags is precisely the
 * placement that would NOT be seen. Costs a little polish at the start of a caption; that is the trade
 * this feature exists to make. An operator who wants it elsewhere writes it into the description
 * themselves and sets `ai_disclosure_note` to an empty string to suppress this one.
 *
 * `note` absent → caption returned unchanged (no stray blank line); caption absent → the note stands alone.
 */
export function prependDisclosureNote(caption: string | undefined, note: string | null): string | undefined {
  if (!note) return caption;
  return caption ? `${note}\n\n${caption}` : note;
}

const VIDEO_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;
const VIDEO_TYPES = new Set(["video", "reel", "short", "story"]);

/** Delivery format: explicit override > content_type > inferred from the media URL. */
export function deriveFormat(opts: { contentType?: string | null; override?: string; mediaUrl: string }): string {
  if (opts.override) return opts.override;
  const ct = (opts.contentType ?? "").trim().toLowerCase();
  if (ct) return ct === "short" ? "reel" : ct;
  return VIDEO_RE.test(opts.mediaUrl) ? "reel" : "image";
}

/** Is the asset a video or an image — from the content type, falling back to the media URL. */
export function mediaKind(contentType: string | null | undefined, mediaUrl: string): "video" | "image" {
  const ct = (contentType ?? "").trim().toLowerCase();
  if (ct === "image" || ct === "photo" || ct === "post" || ct === "feed_post" || ct === "carousel") return "image";
  if (VIDEO_TYPES.has(ct)) return "video";
  return VIDEO_RE.test(mediaUrl) ? "video" : "image";
}

// Each provider names the same intent differently — vertical short video is a "reel" on Meta, a
// "short" on YouTube, a "video" on TikTok/X/Threads/LinkedIn. A single content targets many platforms,
// so the delivery format MUST be resolved per platform.
const PLATFORM_FORMAT: Record<string, { video: string; image: string }> = {
  instagram: { video: "reel", image: "feed_post" },
  facebook: { video: "reel", image: "feed_post" },
  youtube: { video: "short", image: "short" },
  tiktok: { video: "video", image: "video" },
  threads: { video: "video", image: "image" },
  // X's RS platform value is "twitter" (aliased to the "x" publish provider). resolveFormat is called
  // with the platform value, so this MUST be keyed "twitter" — keyed "x" it never matched and a
  // twitter video fell back to "reel", which the x provider rejects ("unsupported format 'reel'").
  twitter: { video: "video", image: "image" },
  linkedin: { video: "video", image: "image" },
};

/** The provider `format` + media `kind` for an editorial post on `platform`. */
export function resolveFormat(
  platform: string,
  contentType: string | null | undefined,
  mediaUrl: string,
): { format: string; kind: "video" | "image" } {
  const kind = mediaKind(contentType, mediaUrl);
  const map = PLATFORM_FORMAT[platform.trim().toLowerCase()];
  const format = map ? map[kind] : kind === "video" ? "reel" : "image";
  return { format, kind };
}

/**
 * YTOPTS1: the extra `options` a post's YouTube columns contribute to a publish request. Every field is
 * omitted when its source column is null (or, for `youtube_tags`, not an array), so a post with them all
 * null contributes an empty object and the pre-YTOPTS1 request shape stays byte-identical. Option names
 * are a FIXED CONTRACT the publish providers read.
 */
export function postPublishOptions(post: {
  youtube_privacy: string | null;
  youtube_tags: unknown;
  youtube_category_id: string | null;
  youtube_made_for_kids: boolean | null;
}): Record<string, unknown> {
  return {
    ...(post.youtube_privacy ? { privacyStatus: post.youtube_privacy } : {}),
    ...(Array.isArray(post.youtube_tags) ? { tags: post.youtube_tags } : {}),
    ...(post.youtube_category_id ? { categoryId: post.youtube_category_id } : {}),
    ...(post.youtube_made_for_kids != null ? { madeForKids: post.youtube_made_for_kids } : {}),
  };
}

/**
 * AIDISC1/2: what a resolved declaration contributes to a publish request.
 *
 *  - `aiDisclosed` — the normalized boolean each provider translates into its own vendor field. Absent
 *    when the platform has no such field, or when nothing was declared.
 *  - `aiDisclosure` — the full resolution (level + note + where each came from), carried so the publish
 *    worker can record the audit trail from the payload it actually sent instead of recomputing it from
 *    the post afterwards. Omitted entirely at level `none`, which keeps a post that declares nothing
 *    byte-identical to the pre-feature request shape.
 */
export function disclosureOptions(platform: string, resolved: ResolvedDisclosure): Record<string, unknown> {
  const aiDisclosed = disclosureFlag(platform, resolved.level);
  return {
    ...(aiDisclosed !== undefined ? { aiDisclosed } : {}),
    ...(resolved.level === "none"
      ? {}
      : {
          aiDisclosure: {
            level: resolved.level,
            levelSource: resolved.levelSource,
            note: resolved.note,
            noteSource: resolved.noteSource,
          },
        }),
  };
}

export interface PublishPostInput {
  postId: string;
  channelId: string;
  when: "now" | string; // "now" or an ISO timestamp (future)
  format?: string;
}

export interface PublishPostDeps {
  /** Register a media URL into storage → returns the media row id (workspace-scoped). */
  registerMedia: (url: string, workspaceId: string) => Promise<{ id: string }>;
}

const defaultDeps: PublishPostDeps = {
  registerMedia: (url, workspaceId) => registerByUrl(url, { storage: getStorage(), probe: defaultProbe }, workspaceId),
};

/**
 * Publish (or schedule) an editorial post through the delivery engine, scoped to a workspace. Atomic:
 * locks the editorial post row, guards against double-publish, creates the delivery on the same
 * transaction, and links it back. Media is registered before the transaction so the delivery's media
 * check sees it committed.
 */
export async function publishPost(
  input: PublishPostInput,
  workspaceId: string,
  deps: PublishPostDeps = defaultDeps,
): Promise<{ delivery: typeof deliveries.$inferSelect; post: typeof posts.$inferSelect }> {
  const post = await db.query.posts.findFirst({
    where: and(eq(posts.id, input.postId), eq(posts.workspace_id, workspaceId)),
  });
  if (!post) throw new ApiError("not_found", "Post not found", 404);
  if (post.delivery_id || post.status === "published") {
    throw new ApiError("conflict", "Post already published", 409);
  }

  // PSA44: enforce the post↔channel platform match in the service (the raw API can pass any channelId).
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, input.channelId), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)),
  });
  if (!channel) throw new ApiError("not_found", "Channel not found", 404);
  if (!channelMatchesPlatform(post.platform, channel)) {
    throw new ApiError("invalid_request", "Channel platform does not match the post", 422);
  }

  const urls = Array.isArray(post.media_urls) ? (post.media_urls as unknown[]) : [];
  // Blank-aware: treat "" / whitespace as absent so a legacy row with an empty video_url doesn't win
  // the coalesce and mask a real media_url / media_urls entry (APIFIX3).
  const pickUrl = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const mediaUrl = pickUrl(post.video_url) ?? pickUrl(post.media_url) ?? pickUrl(urls[0]);

  const content = post.content_id
    ? await db.query.content.findFirst({ where: and(eq(contentTable.id, post.content_id), eq(contentTable.workspace_id, workspaceId)) })
    : undefined;

  // AIDISC2: resolve the declaration down the post → channel → brand cascade. The brand row is only
  // fetched when the channel is actually assigned to one, so the common unbranded case adds no query.
  const brand = channel.brand_key
    ? await db.query.brands.findFirst({
        where: and(eq(brands.workspace_id, workspaceId), eq(brands.key, channel.brand_key)),
      })
    : undefined;
  const disclosure = resolveDisclosure({ post, channel, brand });
  // AIDISC1: the in-content disclosure line (if any) goes into the caption BEFORE the request is built,
  // so it reaches every platform — including the three with no native disclosure field at all, where it
  // is the only disclosure the audience ever sees.
  const caption = prependDisclosureNote(buildCaption(post.description, post.hashtags), disclosure.note);
  // Title for publish targets that require one (YouTube / LinkedIn article): the post's own title
  // wins, else the linked content's (APIFIX4). Blank normalizes to absent.
  const title = [post.title, content?.title].map((t) => t?.trim()).find((t) => !!t);
  const extraOptions = { ...postPublishOptions(post), ...disclosureOptions(post.platform, disclosure) };
  // COMPOSE1: per-post automation overrides. Only set when explicitly chosen on the post — a null
  // column leaves the field absent so the publish-worker falls back to the channel default.
  const overrides = {
    ...(post.first_comment != null ? { firstComment: post.first_comment } : {}),
    ...(post.auto_story != null ? { autoStory: post.auto_story } : {}),
  };

  let request: PublishRequest;
  if (mediaUrl) {
    // Register media BEFORE the tx — createDelivery validates media on a separate connection.
    const media = await deps.registerMedia(mediaUrl, workspaceId);
    const resolved = resolveFormat(post.platform, content?.content_type, mediaUrl);
    request = {
      format: input.format ?? resolved.format,
      media: [{ mediaId: media.id }],
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      options: { mediaKind: resolved.kind, ...(post.cover_url ? { coverUrl: post.cover_url } : {}), ...extraOptions },
      ...overrides,
    };
  } else {
    // LIPUB1: no media file. Allowed only when the target provider advertises a text format that needs
    // no media (LinkedIn / X / Threads); media-only platforms (IG/FB/YouTube/TikTok) still 422 here.
    // The rest of the capability rules (incl. "caption required") are enforced downstream by validate().
    const supportsText = getProviderForPlatform(post.platform)
      .capabilities()
      .some((c) => c.format === "text" && c.media.min === 0);
    if (!supportsText) throw new ApiError("invalid_request", "Post has no media to publish", 422);
    request = {
      format: input.format ?? "text",
      media: [],
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      options: { ...extraOptions },
      ...overrides,
    };
  }
  const scheduledAt = (input.when === "now" ? new Date() : new Date(input.when)).toISOString();
  if (Number.isNaN(Date.parse(scheduledAt))) throw new ApiError("invalid_request", "Invalid when", 422);

  const delivery = await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT delivery_id, status FROM posts WHERE id = ${input.postId} AND workspace_id = ${workspaceId} FOR UPDATE`,
    );
    const row = locked.rows[0] as { delivery_id: string | null; status: string } | undefined;
    if (!row) throw new ApiError("not_found", "Post not found", 404);
    if (row.delivery_id || row.status === "published") {
      throw new ApiError("conflict", "Post already published", 409);
    }
    const d = await createDelivery({ channelId: input.channelId, scheduledAt, request }, workspaceId, tx);
    await tx
      .update(posts)
      .set({ delivery_id: d.id, status: "scheduled", updated_at: new Date() })
      .where(eq(posts.id, input.postId));
    return d;
  });

  const updated = await db.query.posts.findFirst({ where: eq(posts.id, input.postId) });
  return { delivery, post: updated! };
}
