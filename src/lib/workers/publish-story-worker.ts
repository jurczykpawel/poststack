import type { JobHelpers } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deliveries, channels, brands, outboundDeliveries, posts, content } from "@/db/schema";
import type { PublishStoryJob } from "@/lib/queue/types";
import type { PublishRequest } from "@/lib/providers/types";
import { decryptTokens } from "@/lib/crypto";
import { toTokenSet } from "@/lib/providers/token-codec";
import { getProviderForPlatform, subKindForPlatform } from "@/lib/providers";
import { PermanentError } from "@/lib/providers/errors";
import { prepareStoryMedia, resolveAutoStoryMode } from "@/lib/stories/media";
import { publishClips } from "@/lib/stories/segments";
import { getStorage } from "@/lib/storage";
import { getStoryRenderer } from "@/lib/stories";
import { runDelivery, type DeliveryChannel } from "./delivery";

export async function processPublishStory(payload: PublishStoryJob, helpers: JobHelpers): Promise<void> {
  const { channelId, deliveryId, idempotencyKey } = payload;

  const delivery = await db.query.deliveries.findFirst({ where: and(eq(deliveries.id, deliveryId), eq(deliveries.channel_id, channelId)) });
  if (!delivery) return; // the source post is gone — nothing to render a Story about
  const workspaceId = delivery.workspace_id;
  const request = delivery.payload as PublishRequest;
  const deliveryKey = idempotencyKey ?? `job:${helpers.job.id}`;
  const ledgerWhere = and(eq(outboundDeliveries.workspace_id, workspaceId), eq(outboundDeliveries.delivery_key, deliveryKey));
  // Clips of a split video already published by an earlier attempt; carried in the ledger payload
  // (the claim rewrites it) so a retry continues with the next clip instead of repeating them.
  const prior = await db.query.outboundDeliveries.findFirst({ where: ledgerWhere, columns: { payload: true } });
  const publishedClips = (prior?.payload as { storyClipHandles?: string[] } | undefined)?.storyClipHandles ?? [];
  const ledgerPayload: Record<string, unknown> = { ...payload, ...(publishedClips.length ? { storyClipHandles: publishedClips } : {}) };

  await runDelivery({
    deliveryKey,
    channelId,
    taskName: "publish-story",
    payload: ledgerPayload,
    helpers,
    send: async (dch: DeliveryChannel) => {
      // The delivery state machine passes a trimmed channel; load the full row for the publish
      // account id (platform_id) + routing metadata + display name.
      const channel = await db.query.channels.findFirst({ where: and(eq(channels.id, dch.id), eq(channels.workspace_id, workspaceId)) });
      if (!channel) throw new Error(`Channel ${dch.id} gone`);
      const provider = getProviderForPlatform(channel.platform);
      if (!provider.publishStory) {
        throw new PermanentError(`Platform ${channel.platform} cannot publish a Story`);
      }
      const publishStory = provider.publishStory.bind(provider);

      const mode = resolveAutoStoryMode(request.autoStoryMode, channel.default_auto_story_mode);
      const selected = await prepareStoryMedia(request, workspaceId, channel.platform, mode, `stories/${deliveryId}`);
      if (selected.fallbackReason) {
        await db.update(outboundDeliveries).set({ payload: { ...ledgerPayload, storyFallbackReason: selected.fallbackReason } }).where(ledgerWhere);
        helpers.logger.info(`auto-story card fallback delivery=${deliveryId} reason=${selected.fallbackReason}`);
      }
      let mediaUrls = selected.mediaUrls;
      if (!mediaUrls) {
        const caption = (request.caption ?? request.title ?? "").trim();
        const accountName = channel.display_name ?? channel.username ?? undefined;

        const brand = channel.brand_key
          ? await db.query.brands.findFirst({ where: and(eq(brands.workspace_id, workspaceId), eq(brands.key, channel.brand_key)), columns: { name: true, accent: true, story_template: true } })
          : undefined;
        const post = await db.query.posts.findFirst({
          where: and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, deliveryId)),
          columns: { language: true, content_id: true },
        });
        const source = !post?.language?.trim() && post?.content_id
          ? await db.query.content.findFirst({
            where: and(eq(content.workspace_id, workspaceId), eq(content.id, post.content_id)),
            columns: { language: true },
          }) : undefined;
        const language = post?.language?.trim() || source?.language?.trim() || "en";
        const bytes = await getStoryRenderer().render(
          { caption, accountName, thumbnail: selected.thumbnail, language, format: request.format },
          { template: brand?.story_template ?? undefined, accent: brand?.accent ?? undefined, brandName: brand?.name ?? accountName },
        );

        // Upload the fresh card to public storage (deterministic key → idempotent re-render on retry).
        // The platform pulls the Story image from this public URL.
        const storage = getStorage();
        const key = `stories/${deliveryId}.jpg`;
        await storage.putBytes(key, bytes, "image/jpeg", { sourceDelivery: deliveryId });
        mediaUrls = [storage.publicUrl(key)];
      }

      const channelMetadata = {
        subKind: subKindForPlatform(channel.platform),
        ...(channel.metadata as Record<string, unknown>),
      };
      const tokens = toTokenSet(decryptTokens(channel.token_encrypted, [`ws:${channel.workspace_id}`, "channels.token_encrypted", channel.platform, channel.platform_id]));
      const handles = await publishClips(mediaUrls, publishedClips,
        async mediaUrl => (await publishStory({ tokens, accountId: channel.platform_id, mediaUrl, mediaKind: selected.mediaKind ?? "image", channelMetadata })).providerHandle,
        async storyClipHandles => { if (mediaUrls.length > 1) await db.update(outboundDeliveries).set({ payload: { ...ledgerPayload, storyClipHandles } }).where(ledgerWhere); });
      return { platformMessageId: handles[0] ?? null };
    },
    // No local table to mirror: the delivery ledger row IS the record of the published Story.
    onSent: async () => {},
  });

  helpers.logger.info(`auto-story processed for delivery=${deliveryId} channel=${channelId}`);
}
