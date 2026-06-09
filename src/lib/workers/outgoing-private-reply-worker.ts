import type { JobHelpers } from "graphile-worker";
import type { OutgoingPrivateReplyJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, conversations } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * Send a private reply to a comment (comment-to-DM, addressed by comment_id). Works for
 * first-touch commenters who have never messaged the page. Routed through the durable
 * delivery state machine (see {@link runDelivery}) so a crash cannot silently duplicate
 * the send or lose the local sent record.
 */
export async function processOutgoingPrivateReply(
  payload: OutgoingPrivateReplyJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, commentId, text, content, sentByRuleId, idempotencyKey, heldMessageId } = payload;
  const messageContent = content ?? { text };

  const persistHeld = async () => {
    if (heldMessageId) return { heldMessageId };
    const [m] = await db
      .insert(messages)
      .values({
        conversation_id: conversationId,
        direction: "outbound",
        text,
        status: "held",
        sent_by_rule_id: sentByRuleId ?? null,
      })
      .returning({ id: messages.id });
    return { heldMessageId: m.id };
  };

  await runDelivery({
    deliveryKey: idempotencyKey ?? `job:${helpers.job.id}`,
    channelId,
    taskName: "outgoing-private-reply",
    payload: payload as unknown as Record<string, unknown>,
    helpers,
    onHeld: persistHeld,
    send: async (channel: DeliveryChannel) => {
      const tokens = decryptTokens(channel.token_encrypted);
      const provider = getProvider(channel.platform);
      if (!provider.sendPrivateReply) {
        throw new Error(`Platform ${channel.platform} does not support private replies`);
      }
      await provider.sendPrivateReply(tokens, commentId, messageContent);
      return { platformMessageId: null };
    },
    onSent: async (tx, platformMessageId) => {
      if (heldMessageId) {
        // Drain replay: flip the parked row in place instead of inserting a duplicate.
        await tx
          .update(messages)
          .set({ status: "sent", platform_message_id: platformMessageId })
          .where(eq(messages.id, heldMessageId));
      } else {
        await tx.insert(messages).values({
          conversation_id: conversationId,
          direction: "outbound",
          text,
          status: "sent",
          platform_message_id: platformMessageId,
          sent_by_rule_id: sentByRuleId ?? null,
        });
      }
      await tx
        .update(conversations)
        .set({ last_message_at: new Date(), last_message_preview: truncateCodePoints(text, 255) })
        .where(eq(conversations.id, conversationId));
    },
  });

  helpers.logger.info(`private reply processed for comment=${commentId}`);
}
