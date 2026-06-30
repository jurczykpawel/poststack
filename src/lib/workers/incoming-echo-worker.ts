import type { JobHelpers } from "graphile-worker";
import { and, eq, lte, isNull, ne, or } from "drizzle-orm";
import { truncateCodePoints } from "@/lib/text";
import type { IncomingEchoJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, conversations, messages } from "@/db/schema";
import { confirmEcho } from "@/lib/webhook-events/echo";
import { ensureConversation, resolveContactId } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * THREADSYNC1: process an echo of a message the PAGE sent (Meta echoes every page-sent message back).
 *
 * Two jobs in one:
 *  1. Confirm one of OUR sends against the delivery ledger (confirmEcho) — a platform-level "it left
 *     Meta" signal — and mark the echo's webhook_events row terminal.
 *  2. Record the message into the conversation thread as an OUTBOUND message, so a reply sent from
 *     ANYWHERE (the FB app, Business Suite, n8n) keeps the conversation whole in our inbox.
 *
 * Our own sends are already recorded (outgoing-message-worker stores the same platform_message_id),
 * so the unique (conversation_id, platform_message_id) constraint dedups them away — only a foreign
 * echo actually inserts. Idempotent: a redelivery re-confirms (guarded) and re-inserts (no-op).
 */
export async function processIncomingEcho(payload: IncomingEchoJob, helpers: JobHelpers): Promise<void> {
  const { platform, pageId, recipientId, mid, text } = payload;
  const messageDate = new Date((payload.timestamp ?? Math.floor(Date.now() / 1000)) * 1000);

  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.platform_id, pageId),
      eq(channels.platform, platform as typeof channels.platform.enumValues[number]),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, workspace_id: true, platform: true },
  });
  if (!channel) {
    helpers.logger.info(`No active channel for echo pageId=${sanitizeForLog(pageId)}, skipping`);
    return;
  }

  // 1. Confirm our own delivery (no-op for a foreign echo) + mark the webhook_events row terminal.
  await confirmEcho(payload.eventKey ?? `echo-${mid}`, mid, channel.id).catch(() => {});

  // 2. Record the page-sent message into the thread (deduped against our own already-stored sends).
  const { contactId } = await resolveContactId(channel, recipientId, { lastInteractionAt: messageDate });
  const preview = text ? truncateCodePoints(text, 255) : null;
  const conversation = await ensureConversation(channel, contactId, { last_message_at: messageDate, last_message_preview: preview });

  const [inserted] = await db
    .insert(messages)
    .values({
      conversation_id: conversation.id,
      direction: "outbound",
      text: text ?? null,
      // TODO(inbox-attachments): parse + store media from foreign echoes (needs echo-payload parsing)
      platform_message_id: mid,
      // An echo is Meta confirming the message left the platform → it was delivered.
      delivered_at: messageDate,
    })
    .onConflictDoNothing({ target: [messages.conversation_id, messages.platform_message_id] })
    .returning({ id: messages.id });

  // Move the inbox forward only for a genuinely new, newest message (never reopen a closed thread on
  // an outbound echo, and never increment unread — this isn't an inbound message).
  if (inserted) {
    await db
      .update(conversations)
      .set({ last_message_at: messageDate, last_message_preview: preview })
      .where(and(eq(conversations.id, conversation.id), or(lte(conversations.last_message_at, messageDate), isNull(conversations.last_message_at))));
    helpers.logger.info(`echo recorded outbound channel=${channel.id} conversation=${conversation.id} mid=${sanitizeForLog(mid)}`);
  } else {
    helpers.logger.info(`echo mid=${sanitizeForLog(mid)} already in thread (our own send or redelivery) — confirmed only`);
  }
}
