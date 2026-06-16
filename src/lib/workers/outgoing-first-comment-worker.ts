import type { JobHelpers } from "graphile-worker";
import type { OutgoingFirstCommentJob } from "@/lib/queue/types";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * FIRSTCOMMENT1: post the configured "first comment" as a NEW top-level comment under a
 * just-published post, through the durable delivery state machine (see {@link runDelivery}) so a
 * crash cannot silently double-post.
 *
 * Best-effort by design: enqueued separately from the publish, with its own delivery key, so a
 * failure here never affects the published post. The deterministic key is set by the enqueuer to the
 * delivery id, making a re-published/retried post reuse the same ledger row instead of double-posting.
 */
export async function processOutgoingFirstComment(
  payload: OutgoingFirstCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, postId, text, idempotencyKey } = payload;

  await runDelivery({
    deliveryKey: idempotencyKey ?? `job:${helpers.job.id}`,
    channelId,
    taskName: "outgoing-first-comment",
    payload: payload as unknown as Record<string, unknown>,
    helpers,
    send: async (channel: DeliveryChannel) => {
      const tokens = decryptChannelToken(channel.token_encrypted);
      const provider = getProvider(channel.platform);
      if (!provider.commentOnPost) {
        throw new Error(`Platform ${channel.platform} cannot post a comment on a post`);
      }
      const sent = await provider.commentOnPost(tokens, postId, text);
      return { platformMessageId: sent.platformMessageId };
    },
    // No local table to mirror: the delivery ledger row IS the record of the first comment.
    onSent: async () => {},
  });

  helpers.logger.info(`first comment processed for post=${postId} channel=${channelId}`);
}
