import type { JobHelpers } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, channels, brands } from "@/db/schema";
import type { PublishStoryJob } from "@/lib/queue/types";
import type { PublishRequest } from "@/lib/providers/types";
import { decryptTokens } from "@/lib/crypto";
import { toTokenSet } from "@/lib/providers/token-codec";
import { getProviderForPlatform, subKindForPlatform } from "@/lib/providers";
import { PermanentError } from "@/lib/providers/errors";
import { getMedia } from "@/lib/media/service";
import { safeFetch } from "@/lib/media/ssrf";
import { getStorage } from "@/lib/storage";
import { getStoryRenderer } from "@/lib/stories";
import { runDelivery, type DeliveryChannel } from "./delivery";

/** Cap the post media we'll pull to composite onto the card (the card is a small JPEG; we don't need
 *  a giant source). 16 MB is comfortably above any reasonable image. */
const MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024;

/** Fetch the post's first image as thumbnail bytes — best-effort. Video / unreadable / oversized
 *  media yields no thumbnail and the renderer falls back to a text-only card. */
async function loadThumbnail(request: PublishRequest, workspaceId: string): Promise<Uint8Array | undefined> {
  const first = request.media[0];
  if (!first) return undefined;
  const m = await getMedia(first.mediaId, workspaceId).catch(() => undefined);
  if (!m || m.kind !== "image") return undefined;
  try {
    const res = await safeFetch(m.url); // SSRF guard — m.url is our own CAS public URL
    if (!res.ok) return undefined;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_THUMBNAIL_BYTES) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength <= MAX_THUMBNAIL_BYTES ? buf : undefined;
  } catch {
    return undefined;
  }
}

/**
 * STORY1: render + publish a generated Story card about a just-published post, through the durable
 * delivery state machine (see {@link runDelivery}) so a crash can't silently double-post a Story.
 *
 * Best-effort by design: enqueued separately from the publish with its own delivery key (the publish
 * delivery id), so a failure here never affects the published post. The card is composed server-side
 * (StoryRenderer), uploaded to public storage, then published via the platform's `publishStory`.
 */
export async function processPublishStory(payload: PublishStoryJob, helpers: JobHelpers): Promise<void> {
  const { channelId, deliveryId, idempotencyKey } = payload;

  const delivery = await db.query.deliveries.findFirst({ where: eq(deliveries.id, deliveryId) });
  if (!delivery) return; // the source post is gone — nothing to render a Story about
  const workspaceId = delivery.workspace_id;
  const request = delivery.payload as PublishRequest;

  await runDelivery({
    deliveryKey: idempotencyKey ?? `job:${helpers.job.id}`,
    channelId,
    taskName: "publish-story",
    payload: payload as unknown as Record<string, unknown>,
    helpers,
    send: async (dch: DeliveryChannel) => {
      // The delivery state machine passes a trimmed channel; load the full row for the publish
      // account id (platform_id) + routing metadata + display name.
      const channel = await db.query.channels.findFirst({ where: eq(channels.id, dch.id) });
      if (!channel) throw new Error(`Channel ${dch.id} gone`);
      const provider = getProviderForPlatform(channel.platform);
      if (!provider.publishStory) {
        throw new PermanentError(`Platform ${channel.platform} cannot publish a Story`);
      }

      const thumbnail = await loadThumbnail(request, workspaceId);
      const caption = (request.caption ?? request.title ?? "").trim();
      const accountName = channel.display_name ?? channel.username ?? undefined;

      // STORYCFG1: brand the card from the channel's brand (accent + name). The template id is the
      // configuration seam — currently the built-in default; a future per-channel/per-post setting
      // (and PRO custom templates/styling) would supply it here without touching this flow.
      const brand = channel.brand_key
        ? await db.query.brands.findFirst({ where: and(eq(brands.workspace_id, workspaceId), eq(brands.key, channel.brand_key)), columns: { name: true, accent: true, story_template: true } })
        : undefined;
      const bytes = await getStoryRenderer().render(
        { caption, accountName, thumbnail },
        { template: brand?.story_template ?? undefined, accent: brand?.accent ?? undefined, brandName: brand?.name ?? accountName },
      );

      // Upload the fresh card to public storage (deterministic key → idempotent re-render on retry).
      // The platform pulls the Story image from this public URL.
      const storage = getStorage();
      const key = `stories/${deliveryId}.jpg`;
      await storage.putBytes(key, bytes, "image/jpeg", { sourceDelivery: deliveryId });
      const mediaUrl = storage.publicUrl(key);

      const channelMetadata = {
        subKind: subKindForPlatform(channel.platform),
        ...(channel.metadata as Record<string, unknown>),
      };
      const tokens = toTokenSet(decryptTokens(channel.token_encrypted));
      const handle = await provider.publishStory({ tokens, accountId: channel.platform_id, mediaUrl, channelMetadata });
      return { platformMessageId: handle.providerHandle };
    },
    // No local table to mirror: the delivery ledger row IS the record of the published Story.
    onSent: async () => {},
  });

  helpers.logger.info(`auto-story processed for delivery=${deliveryId} channel=${channelId}`);
}
