import type { JobHelpers } from "graphile-worker";
import type { OutgoingCommentJob } from "@/lib/queue/types";
import { and, eq } from "drizzle-orm";
import { commentLogs } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * Post a public reply to a comment via the platform API, through the durable delivery
 * state machine (see {@link runDelivery}) so a crash cannot silently double-post or lose
 * the `reply_sent` record.
 */
export async function processOutgoingComment(
  payload: OutgoingCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, commentId, text, sentByRuleId, idempotencyKey } = payload;

  await runDelivery({
    deliveryKey: idempotencyKey ?? `job:${helpers.job.id}`,
    channelId,
    taskName: "outgoing-comment",
    payload: payload as unknown as Record<string, unknown>,
    helpers,
    send: async (channel: DeliveryChannel) => {
      const tokens = decryptChannelToken(channel.token_encrypted);
      const provider = getProvider(channel.platform);
      if (!provider.sendComment) {
        throw new Error(`Platform ${channel.platform} does not support comments`);
      }
      await provider.sendComment(tokens, commentId, text);
      return { platformMessageId: null };
    },
    onSent: async (tx) => {
      await tx
        .update(commentLogs)
        .set({ reply_sent: true, matched_rule_id: sentByRuleId ?? null })
        .where(and(eq(commentLogs.platform_comment_id, commentId), eq(commentLogs.channel_id, channelId)));
    },
  });

  helpers.logger.info(`public reply processed for comment=${commentId}`);
}
