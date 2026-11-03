import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, deliveries, media, postPreviews, posts } from "@/db/schema";
import type { Platform } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { casKey } from "@/lib/media/cas";
import { readBodyCapped } from "@/lib/media/read-capped";
import { sniffMime } from "@/lib/media/sniff";
import { safeFetch } from "@/lib/media/ssrf";
import { postUrlFor, videoThumbFor } from "@/lib/posts/post-url";
import { getStorage } from "@/lib/storage";
import type { Storage } from "@/lib/storage/types";

/** What the shared post card shows (POSTPREVIEW1), whoever published the post. */
export interface PostCardData {
  platform: string;
  channelName: string;
  text: string | null;
  imageUrl: string | null;
  video: boolean;
  url: string | null;
  at: Date | null;
}

export interface PreviewDeps {
  storage?: Storage;
  fetchImage?: (url: string) => Promise<Response>;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RETRY_FAILED_MS = 24 * 3600_000;
const httpUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);
const nameOf = (c: { display_name: string | null; username: string | null; platform_id: string }) => c.display_name ?? c.username ?? c.platform_id;

/** A post PostStack published: everything comes from our rows, the platform is never asked. */
export async function deliveryPostCard(workspaceId: string, deliveryId: string): Promise<PostCardData | undefined> {
  const [row] = await db.select({ delivery: deliveries, channel: channels, post: posts }).from(deliveries)
    .innerJoin(channels, and(eq(channels.id, deliveries.channel_id), eq(channels.workspace_id, workspaceId)))
    .leftJoin(posts, and(eq(posts.delivery_id, deliveries.id), eq(posts.workspace_id, workspaceId)))
    .where(and(eq(deliveries.id, deliveryId), eq(deliveries.workspace_id, workspaceId))).orderBy(posts.id).limit(1);
  if (!row) return undefined;
  const { delivery, channel, post } = row;
  const payload = delivery.payload as { caption?: string; title?: string; media?: Array<{ mediaId?: string }> };
  const mediaId = payload.media?.[0]?.mediaId;
  const [first] = mediaId
    ? await db.select({ url: media.url, kind: media.kind }).from(media).where(and(eq(media.workspace_id, workspaceId), sql`${media.id}::text = ${mediaId}`))
    : [];
  return {
    platform: channel.platform,
    channelName: nameOf(channel),
    text: post?.description || payload.caption || post?.title || payload.title || null,
    imageUrl: first?.kind === "image" ? httpUrl(first.url) : videoThumbFor(channel.platform, delivery.provider_handle),
    video: first?.kind === "video",
    url: httpUrl(post?.published_url) ?? httpUrl(delivery.provider_handle) ?? postUrlFor(channel.platform, delivery.provider_handle, channel.username),
    at: post?.published_at ?? (delivery.status === "sent" ? delivery.updated_at : null),
  };
}

/** Copy a platform CDN picture (signed, it expires) into our storage; null when it is not an image. */
async function copyImage(url: string, storage: Storage, fetchImage: (url: string) => Promise<Response>): Promise<string | null> {
  try {
    const res = await fetchImage(url);
    if (!res.ok) return null;
    const bytes = await readBodyCapped(res, MAX_IMAGE_BYTES);
    const mime = sniffMime(bytes);
    if (!mime?.startsWith("image/")) return null;
    const key = casKey(createHash("sha256").update(bytes).digest("hex"), mime);
    if (!(await storage.head(key)).exists) await storage.putBytes(key, bytes, mime);
    return storage.publicUrl(key);
  } catch {
    return null;
  }
}

/**
 * A post made outside PostStack: read once from the platform and remembered in post_previews, so a
 * view never calls the API again. A failed read is remembered too (text-only card), retried after a day.
 */
export async function externalPostCard(workspaceId: string, channelId: string, postId: string, deps: PreviewDeps = {}): Promise<PostCardData | undefined> {
  const channel = await db.query.channels.findFirst({ where: and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId)) });
  if (!channel) return undefined;
  const key = and(eq(postPreviews.workspace_id, workspaceId), eq(postPreviews.channel_id, channelId), eq(postPreviews.post_id, postId));
  let row = await db.query.postPreviews.findFirst({ where: key });
  if (!row || (row.status === "failed" && Date.now() - row.fetched_at.getTime() > RETRY_FAILED_MS)) {
    let values: Omit<typeof postPreviews.$inferInsert, "workspace_id" | "channel_id" | "post_id"> = { status: "failed", fetched_at: new Date() };
    try {
      const provider = getProvider(channel.platform as Platform);
      if (provider.getPostPreview) {
        const p = await provider.getPostPreview(decryptChannelToken(channel.token_encrypted), postId);
        const image = httpUrl(p.imageUrl);
        const imageUrl = image ? await copyImage(image, deps.storage ?? getStorage(), deps.fetchImage ?? ((u) => safeFetch(u, { signal: AbortSignal.timeout(15_000) }))) : null;
        values = { status: "ready", text: p.text, image_url: imageUrl, permalink: httpUrl(p.url), posted_at: p.postedAt, fetched_at: new Date() };
      }
    } catch {
      // Deleted post, missing permission or a broken token: the card shows without content.
    }
    await db.insert(postPreviews).values({ workspace_id: workspaceId, channel_id: channelId, post_id: postId, ...values })
      .onConflictDoUpdate({ target: [postPreviews.workspace_id, postPreviews.channel_id, postPreviews.post_id], set: values });
    row = await db.query.postPreviews.findFirst({ where: key });
  }
  return {
    platform: channel.platform,
    channelName: nameOf(channel),
    text: row?.text ?? null,
    imageUrl: row?.image_url ?? null,
    video: false,
    url: row?.permalink ?? null,
    at: row?.posted_at ?? null,
  };
}
