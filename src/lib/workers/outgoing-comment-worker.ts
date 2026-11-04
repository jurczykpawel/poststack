import type { JobHelpers } from "graphile-worker";
import type { OutgoingCommentJob } from "@/lib/queue/types";
import { and, eq, sql } from "drizzle-orm";
import { commentLogs, conversations, messages } from "@/db/schema";
import { truncateCodePoints } from "@/lib/text";
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
    allowWhenPaused: !!payload.manualReplyAt,
    send: async (channel: DeliveryChannel) => {
      const tokens = decryptChannelToken(channel.token_encrypted);
      const provider = getProvider(channel.platform);
      if (!provider.sendComment) {
        throw new Error(`Platform ${channel.platform} does not support comments`);
      }
      const sent = await provider.sendComment(tokens, commentId, text);
      return { platformMessageId: sent.platformMessageId };
    },
    onSent: async (tx, platformMessageId) => {
      if (payload.conversationId && payload.manualReplyAt && payload.workspaceId) {
        await tx.insert(messages).values({ conversation_id: payload.conversationId, direction: "outbound", text, status: "sent", platform_message_id: platformMessageId });
        await tx.update(conversations).set({ needs_manual_reply: false, last_message_at: new Date(), last_message_preview: truncateCodePoints(text, 255) })
          .where(and(eq(conversations.id, payload.conversationId), eq(conversations.channel_id, channelId), eq(conversations.workspace_id, payload.workspaceId), sql`(${conversations.last_message_at} IS NULL OR date_trunc('milliseconds', ${conversations.last_message_at}) <= ${payload.manualReplyAt}::timestamptz)`));
      }
      await tx
        .update(commentLogs)
        .set({ reply_sent: true, reply_text: text, matched_rule_id: sentByRuleId ?? null })
        .where(and(eq(commentLogs.platform_comment_id, commentId), eq(commentLogs.channel_id, channelId)));
    },
  });

  helpers.logger.info(`public reply processed for comment=${commentId}`);
}
