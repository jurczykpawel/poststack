import type { JobHelpers } from "graphile-worker";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, conversations, contacts } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { refreshIfNearExpiry } from "@/lib/channels/refresh-if-near-expiry";
import { messagingWindowState } from "@/lib/platforms/messaging-window";
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

  // Meta 24h window: a human reply past the standard window must ride the HUMAN_AGENT tag (valid up
  // to 7 days). Auto-replies always stay RESPONSE — bots may not use HUMAN_AGENT, and they fire
  // inside the window anyway. Read the conversation's window anchor (`last_inbound_at`) at send time.
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { platform: true, thread_type: true, last_inbound_at: true, thread_ref: true, subject: true },
  });
  const useHumanAgentTag =
    isHumanReply &&
    messagingWindowState({
      platform: conv?.platform ?? "",
      threadType: conv?.thread_type,
      lastInboundAt: conv?.last_inbound_at ?? null,
    }).useHumanAgentTag;

  // Email reply context: thread via the Gmail threadId (thread_ref) and carry the subject. In-Reply-To
  // uses the last inbound message's stored platform_message_id — which IS the RFC Message-ID
  // (`<...@mail>`) when the source mail carried one; set it only then, else rely on threadId alone.
  let emailReply: { threadId?: string; inReplyTo?: string; subject?: string } | undefined;
  if (conv?.thread_type === "email") {
    const lastInbound = await db.query.messages.findFirst({
      where: and(eq(messages.conversation_id, conversationId), eq(messages.direction, "inbound")),
      orderBy: [desc(messages.created_at)],
      columns: { platform_message_id: true },
    });
    const rfcMessageId = lastInbound?.platform_message_id;
    const inReplyTo = rfcMessageId && rfcMessageId.startsWith("<") ? rfcMessageId : undefined;
    emailReply = { threadId: conv.thread_ref || undefined, subject: conv.subject ?? undefined, inReplyTo };
  }

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

      // On-demand token refresh if near expiry (shared helper, also used by the email poll).
      const refresh = await refreshIfNearExpiry(channelId, provider, tokens);
      tokens = refresh.tokens;
      if (refresh.refreshed) helpers.logger.info("Token refreshed on-demand before send");

      const sent = await provider.sendMessage(
        tokens,
        recipientPlatformId,
        content,
        emailReply
          ? { email: emailReply }
          : useHumanAgentTag
            ? { messagingTag: "HUMAN_AGENT" }
            : undefined,
      );
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
