import type { JobHelpers } from "graphile-worker";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messages, conversations, contacts } from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { runDelivery, type DeliveryChannel } from "./delivery";

/**
 * Send an outbound message via the platform API, through the durable delivery state
 * machine (see {@link runDelivery}): the provider call is committed-between a `sending`
 * claim and an atomic `sent`+persist, so a crash can never silently duplicate the send
 * or lose the local sent record.
 */
export async function processOutgoingMessage(
  payload: OutgoingMessageJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, contactId, recipientPlatformId, content, sentByRuleId, sentByUserId, isManual, idempotencyKey, heldMessageId } =
    payload;

  // A human operator's manual reply is exempt from the automation gates below. Key on `isManual`
  // (set by the manual-reply endpoint) OR `sentByUserId` — an API-key reply nulls sentByUserId yet
  // is still a human action, so sentByUserId alone would wrongly gate it.
  const isHumanReply = !!isManual || !!sentByUserId;

  // Consent re-check at delivery time: the contact may have unsubscribed in the window
  // between enqueue and send, so re-read it here — the other DM-producing paths (sequence-step,
  // follow-gate) already do. A human's OWN manual reply is exempt: unsubscribe governs automated
  // messaging, not a human agent answering a live conversation.
  if (!isHumanReply) {
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, contactId),
      columns: { is_subscribed: true },
    });
    if (!contact?.is_subscribed) {
      helpers.logger.info(`Contact ${contactId} unsubscribed — skipping automated outgoing message`);
      return;
    }
  }

  // Park the outbound as `held` — awaiting drain, NOT `failed`. On drain
  // (heldMessageId set) the row already exists, so re-parking is a no-op; return the
  // existing/created row id so the ledger can point a drain replay back at it.
  const persistHeld = async () => {
    if (heldMessageId) return { heldMessageId };
    const [m] = await db
      .insert(messages)
      .values({
        conversation_id: conversationId,
        direction: "outbound",
        text: content.text ?? null,
        status: "held",
        sent_by_rule_id: sentByRuleId ?? null,
      })
      .returning({ id: messages.id });
    return { heldMessageId: m.id };
  };

  await runDelivery({
    deliveryKey: idempotencyKey ?? `job:${helpers.job.id}`,
    channelId,
    taskName: "outgoing-message",
    payload: payload as unknown as Record<string, unknown>,
    helpers,
    // A human's own manual reply still goes out while the channel is paused.
    allowWhenPaused: isHumanReply,
    onHeld: persistHeld,
    send: async (channel: DeliveryChannel) => {
      let tokens = decryptChannelToken(channel.token_encrypted);
      const provider = getProvider(channel.platform);

      // On-demand token refresh if near expiry.
      if (provider.requiresTokenRefresh() && tokens.expires_at) {
        const expiresAt = tokens.expires_at as number;
        const bufferSeconds = provider.refreshBufferSeconds();
        if (Date.now() / 1000 >= expiresAt - bufferSeconds) {
          try {
            tokens = await provider.refreshToken(tokens);
            await db.update(channels).set({ token_encrypted: encryptTokens(tokens) }).where(eq(channels.id, channelId));
            helpers.logger.info("Token refreshed on-demand before send");
          } catch (err) {
            helpers.logger.info(`Token refresh failed, using existing: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const sent = await provider.sendMessage(tokens, recipientPlatformId, content);
      return { platformMessageId: sent.platformMessageId };
    },
    onSent: async (tx, platformMessageId) => {
      if (heldMessageId) {
        await tx
          .update(messages)
          .set({ status: "sent", platform_message_id: platformMessageId })
          .where(eq(messages.id, heldMessageId));
      } else {
        await tx.insert(messages).values({
          conversation_id: conversationId,
          direction: "outbound",
          text: content.text ?? null,
          platform_message_id: platformMessageId,
          status: "sent",
          sent_by_rule_id: sentByRuleId ?? null,
        });
      }
      await tx
        .update(conversations)
        .set({
          last_message_at: new Date(),
          last_message_preview: content.text ? truncateCodePoints(content.text, 255) : null,
        })
        .where(eq(conversations.id, conversationId));
    },
  });
}
