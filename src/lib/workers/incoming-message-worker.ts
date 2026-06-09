import type { JobHelpers } from "graphile-worker";
import { and, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { IncomingMessageJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, contactChannels, contacts, conversations, messages } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEventOnce } from "@/lib/idempotency";
import { ensureConversation } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Process an incoming DM from Facebook/Instagram.
 *
 * 1. Resolve Channel from pageId
 * 2. Upsert Contact + ContactChannel (dedup by platform_sender_id)
 * 3. Upsert Conversation (one per channel+contact pair)
 * 4. Insert inbound Message (dedup by unique platform_message_id constraint)
 * 5. Evaluate auto-reply rules
 */
export async function processIncomingMessage(
  payload: IncomingMessageJob,
  helpers: JobHelpers,
): Promise<void> {
  const { platform, channelId, pageId, senderId, mid, text, quickReplyPayload, postbackPayload, isStoryReply, isStoryMention, timestamp } = payload;

  // Validate timestamp bounds (reject absurd values)
  const messageDate = new Date(timestamp * 1000);
  const now = Date.now();
  if (messageDate.getTime() > now + 86_400_000 || messageDate.getTime() < now - 30 * 86_400_000 * 365) {
    helpers.logger.info(`Invalid timestamp=${timestamp}, using current time`);
    messageDate.setTime(now);
  }

  // 1. Resolve the channel. Prefer the channelId the webhook already verified
  //    (Telegram); otherwise look it up by (platform, platform_id) — globally
  //    unique, so routing is unambiguous and never crosses platforms/workspaces.
  const channel = await db.query.channels.findFirst({
    where: and(
      channelId ? eq(channels.id, channelId) : eq(channels.platform_id, pageId),
      eq(channels.platform, platform as typeof channels.platform.enumValues[number]),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, workspace_id: true, platform: true, status: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for platform=${sanitizeForLog(platform)} pageId=${sanitizeForLog(pageId)} channelId=${channelId ?? "-"}, skipping`);
    return;
  }

  // 2. Resolve the contact identity (find or create). Activity (last_interaction_at) is
  //    bumped later, only for a newly-ingested message, so a redelivery doesn't move it.
  const existingCC = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
    columns: { contact_id: true },
  });

  let contactId: string;
  if (existingCC) {
    contactId = existingCC.contact_id;
  } else {
    contactId = await db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({ workspace_id: channel.workspace_id, last_interaction_at: messageDate })
        .returning({ id: contacts.id });
      await tx.insert(contactChannels).values({
        contact_id: contact.id,
        channel_id: channel.id,
        platform_sender_id: senderId,
      });
      return contact.id;
    });
  }

  // 3. Ensure the conversation exists WITHOUT mutating its lifecycle (status/stats); those
  //    change only for a genuinely new, newest message (steps 5/6), so a redelivery can't
  //    reopen a closed conversation or move the inbox backwards.
  const preview = text ? text.slice(0, 255) : null;
  const conversation = await ensureConversation(channel, contactId, { last_message_at: messageDate, last_message_preview: preview });

  // 4. Insert inbound Message — unique on (conversation_id, platform_message_id) dedups a
  //    redelivery and a concurrent race; a no-op conflict means it was already ingested.
  const [inserted] = await db
    .insert(messages)
    .values({
      conversation_id: conversation.id,
      direction: "inbound",
      text: text ?? null,
      quick_reply_payload: quickReplyPayload ?? null,
      postback_payload: postbackPayload ?? null,
      platform_message_id: mid,
    })
    .onConflictDoNothing({ target: [messages.conversation_id, messages.platform_message_id] })
    .returning({ id: messages.id });

  const isNewMessage = !!inserted;
  const eventKey = `message:${conversation.id}:${mid}`;

  // Apply `set` only when THIS message is (still) the conversation's newest activity:
  // `last_message_at <= messageDate` (or no activity yet). Guards preview/status/attention
  // against an out-of-order or stale event moving state backwards. Uses the
  // typed messageDate binding consistently (no raw-SQL Date), so the comparison matches how
  // last_message_at is written.
  const ifLatest = (set: Partial<typeof conversations.$inferInsert>) =>
    db.update(conversations)
      .set(set)
      .where(and(
        eq(conversations.id, conversation.id),
        or(lte(conversations.last_message_at, messageDate), isNull(conversations.last_message_at)),
      ));

  // 5. New message → advance activity monotonically (never backwards), exactly once.
  if (isNewMessage) {
    // unread always increments — it's a new message regardless of arrival order.
    await db.update(conversations)
      .set({ unread_count: sql`${conversations.unread_count} + 1` })
      .where(eq(conversations.id, conversation.id));
    // Timestamps, preview and reopen only when this message is the newest activity, so an
    // out-of-order older message can't move the inbox/preview backwards or reopen it.
    await ifLatest({ last_message_at: messageDate, last_inbound_at: messageDate, last_message_preview: preview, status: "open" });
    await db.update(contacts)
      .set({ last_interaction_at: messageDate })
      .where(and(eq(contacts.id, contactId), or(lt(contacts.last_interaction_at, messageDate), isNull(contacts.last_interaction_at))));
    helpers.logger.info(
      `channel=${channel.id} contact=${contactId} conversation=${conversation.id} mid=${sanitizeForLog(mid)}`
    );
  } else {
    helpers.logger.info(`mid=${sanitizeForLog(mid)} already ingested — re-evaluating (idempotent via event key)`);
  }

  // 6. Evaluate auto-reply rules. When paused, the event is still terminally claimed so a
  //    redelivery after unpause doesn't reply to an old message, and a genuinely new
  //    inbound during the pause is surfaced for a human. Otherwise always evaluate,
  //    even on a redelivery/retry: the event key makes the rule fire at most once, and any
  //    failure propagates so the job retries rather than being lost to the dedup.
  // A manually paused channel still ingests to the inbox but runs no automation —
  // same handling as a per-conversation pause: surface a new DM for a human, don't auto-reply.
  if (conversation.is_automation_paused || channel.status === "paused") {
    await claimEventOnce(eventKey);
    if (isNewMessage) await ifLatest({ needs_manual_reply: true });
    return;
  }

  try {
    const { outcome, ruleId } = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      conversationId: conversation.id,
      contactId,
      recipientPlatformId: senderId,
      text,
      eventType: "message",
      quickReplyPayload,
      postbackPayload,
      isStoryReply,
      isStoryMention,
      eventKey,
    });
    // Change the flag only for an outcome THIS call actually decided: a fired reply
    // clears it, a real no-match raises it, and an `already`-handled event (a concurrent or
    // redelivered duplicate) leaves it untouched — so a lost claim race can't wrongly flag a
    // conversation that another worker just auto-replied to.
    if (outcome === "fired") await ifLatest({ needs_manual_reply: false });
    else if (outcome === "no_match") await ifLatest({ needs_manual_reply: true });
    if (ruleId) helpers.logger.info(`Rule fired: ${ruleId}`);
  } catch (err) {
    // The auto-reply couldn't be produced/queued. Earlier attempts just retry; on the final
    // attempt the reply is permanently lost, so flag the conversation for a human before
    // rethrowing (which dead-letters the job) — otherwise the failure is silent.
    const job: { attempts: number; max_attempts: number } | undefined = helpers.job;
    if (job && job.attempts >= job.max_attempts) {
      await ifLatest({ needs_manual_reply: true });
    }
    throw err;
  }
}
