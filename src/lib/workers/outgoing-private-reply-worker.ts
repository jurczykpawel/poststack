import type { JobHelpers } from "graphile-worker";
import type { OutgoingPrivateReplyJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, conversations, commentLogs, channels } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { ensureConversation, DM_THREAD } from "./resolve-contact";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * Send a private reply to a comment (comment-to-DM, addressed by comment_id). Works for
 * first-touch commenters who have never messaged the page. Routed through the durable
 * delivery state machine (see {@link runDelivery}) so a crash cannot silently duplicate
 * the send or lose the local sent record.
 */
/**
 * The DM thread conversation id for (channel, contact). A comment-triggered DM is addressed by
 * comment_id on the platform, but in OUR inbox it belongs to the contact's DM thread, kept separate
 * from the comment thread. Best-effort: on any failure fall back to the incoming conversation so a
 * reply is never dropped over a threading detail.
 */
async function resolveDmThread(channelId: string, contactId: string | undefined, fallback: string): Promise<string> {
  if (!contactId) return fallback;
  try {
    const channel = await db.query.channels.findFirst({
      where: eq(channels.id, channelId),
      columns: { id: true, workspace_id: true, platform: true },
    });
    if (!channel) return fallback;
    const conv = await ensureConversation(channel, contactId, { last_message_at: new Date(), last_message_preview: null }, DM_THREAD);
    return conv.id;
  } catch {
    return fallback;
  }
}

export async function processOutgoingPrivateReply(
  payload: OutgoingPrivateReplyJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, commentId, contactId, text, content, sentByRuleId, idempotencyKey, heldMessageId } = payload;
  const messageContent = content ?? { text };

  // A comment-triggered DM belongs to the contact's DM thread, NOT the comment thread, so the inbox
  // keeps comment and DM as two separate threads. Resolve (or create) that DM thread up front and
  // record the message there. Falls back to the incoming conversation if resolution isn't possible.
  const dmConversationId = await resolveDmThread(channelId, contactId, conversationId);

  const persistHeld = async () => {
    if (heldMessageId) return { heldMessageId };
    const [m] = await db
      .insert(messages)
      .values({
        conversation_id: dmConversationId,
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
      const tokens = decryptChannelToken(channel.token_encrypted);
      const provider = getProvider(channel.platform);
      if (!provider.sendPrivateReply) {
        throw new Error(`Platform ${channel.platform} does not support private replies`);
      }
      const sent = await provider.sendPrivateReply(tokens, commentId, messageContent);
      // Store the returned id so the inbound echo of this very DM (THREADSYNC1) is deduped against
      // this row rather than logged as a second outbound message in the thread.
      return { platformMessageId: sent.platformMessageId };
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
          conversation_id: dmConversationId,
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
        .where(eq(conversations.id, dmConversationId));
      // Flip the comment-log's `dm_sent` so a comment that triggered a DM is queryable as such,
      // mirroring how the public-reply worker sets `reply_sent` — scoped by (commentId, channelId).
      // In the same transaction as the sent-ledger write so a crash can't leave it half-set.
      await tx
        .update(commentLogs)
        .set({ dm_sent: true })
        .where(and(eq(commentLogs.platform_comment_id, commentId), eq(commentLogs.channel_id, channelId)));
    },
  });

  helpers.logger.info(`private reply processed for comment=${commentId}`);
}
