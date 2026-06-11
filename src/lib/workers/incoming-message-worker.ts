import type { JobHelpers } from "graphile-worker";
import { and, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { truncateCodePoints } from "@/lib/text";
import type { IncomingMessageJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, contacts, conversations, messages } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEvent, linkEventOutcome, markEventOnTerminalFailure } from "@/lib/idempotency";
import { dispatchAlert } from "@/lib/notifications/alert";
import { ensureConversation, resolveContactId } from "./resolve-contact";
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
  // The fire-claim CAS key: prefer the event_key the edge logged this event under, so the claim
  // lands on that exact webhook_events row. Fall back to a per-(conversation, mid) key for a direct
  // worker invocation that skipped the edge log (tests / replays) — per-conversation so a shared
  // platform id across two conversations still dedups independently.
  const claimKeyOf = (conversationId: string) => payload.eventKey ?? `message:${conversationId}:${mid}`;

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

  // 2. Resolve the contact identity (find or create) via the shared, race-hardened helper.
  //    Previously this path had its OWN inline find-or-create that never received the
  //    onConflictDoNothing + orphan-rollback, so two concurrent first-DMs from a new sender
  //    dead-lettered the loser on a 23505. Activity (last_interaction_at) is bumped later,
  //    only for a newly-ingested newest message, so a redelivery doesn't move it — hence the
  //    contact is created with messageDate and NOT bumped here.
  const { contactId } = await resolveContactId(channel, senderId, { lastInteractionAt: messageDate });

  // 3. Ensure the conversation exists WITHOUT mutating its lifecycle (status/stats); those
  //    change only for a genuinely new, newest message (steps 5/6), so a redelivery can't
  //    reopen a closed conversation or move the inbox backwards.
  const preview = text ? truncateCodePoints(text, 255) : null;
  const conversation = await ensureConversation(channel, contactId, { last_message_at: messageDate, last_message_preview: preview });

  const eventKey = claimKeyOf(conversation.id);

  // 4+5. Insert the inbound message AND its counter updates in ONE transaction: a crash
  //      between the insert and the counters would otherwise leave the message committed but the
  //      counters permanently skipped — the retry sees the insert conflict, treats it as a duplicate
  //      (isNewMessage=false) and never re-applies them, leaving unread under-counted and
  //      last_inbound_at NULL (which mis-anchors the drain's 24h messaging window). Inside the tx a
  //      genuine duplicate's insert returns no row → counters correctly skipped (preserved).
  //      unique on (conversation_id, platform_message_id) dedups a redelivery and a concurrent race.
  let messageId: string | null = null;
  const isNewMessage = await db.transaction(async (tx) => {
    const [inserted] = await tx
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
    if (!inserted) return false;
    messageId = inserted.id;
    // unread always increments — it's a new message regardless of arrival order.
    await tx.update(conversations)
      .set({ unread_count: sql`${conversations.unread_count} + 1` })
      .where(eq(conversations.id, conversation.id));
    // Timestamps, preview and reopen only when this message is the newest activity, so an
    // out-of-order older message can't move the inbox/preview backwards or reopen it.
    await tx.update(conversations)
      .set({ last_message_at: messageDate, last_inbound_at: messageDate, last_message_preview: preview, status: "open" })
      .where(and(eq(conversations.id, conversation.id), or(lte(conversations.last_message_at, messageDate), isNull(conversations.last_message_at))));
    await tx.update(contacts)
      .set({ last_interaction_at: messageDate })
      .where(and(eq(contacts.id, contactId), or(lt(contacts.last_interaction_at, messageDate), isNull(contacts.last_interaction_at))));
    return true;
  });

  // `ifLatest` (db-scoped) is used by the attention-flag mutations in step 6 — a separate concern
  // from the ingest counters above, deliberately outside the ingest transaction. Applies `set` only
  // while THIS message is still the newest activity, using the typed messageDate.
  const ifLatest = (set: Partial<typeof conversations.$inferInsert>) =>
    db.update(conversations)
      .set(set)
      .where(and(
        eq(conversations.id, conversation.id),
        or(lte(conversations.last_message_at, messageDate), isNull(conversations.last_message_at)),
      ));

  if (isNewMessage) {
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
    await claimEvent(eventKey, "paused", { contact_id: contactId, conversation_id: conversation.id, message_id: messageId }, db, { event_type: "message" });
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
    // Attach the inbound message row to the now-claimed event (the executor records
    // contact/conversation inside the fire tx; the message id is only known here). Skip on
    // `already` (a redelivery must not clobber the original outcome).
    if (outcome !== "already") await linkEventOutcome(eventKey, { message_id: messageId });
    // Change the flag only for an outcome THIS call actually decided: a fired reply
    // clears it, a real no-match raises it, and an `already`-handled event (a concurrent or
    // redelivered duplicate) leaves it untouched — so a lost claim race can't wrongly flag a
    // conversation that another worker just auto-replied to.
    if (outcome === "fired") await ifLatest({ needs_manual_reply: false });
    else if (outcome === "no_match") await ifLatest({ needs_manual_reply: true });
    if (ruleId) helpers.logger.info(`Rule fired: ${ruleId}`);
  } catch (err) {
    // The auto-reply couldn't be produced/queued. Earlier attempts just retry; on the final
    // attempt the reply is permanently lost, so flag the conversation for a human and record the
    // event as `error` before rethrowing (which dead-letters the job) — otherwise it's silent.
    const job: { attempts: number; max_attempts: number } | undefined = helpers.job;
    if (job && job.attempts >= job.max_attempts) {
      await ifLatest({ needs_manual_reply: true });
    }
    const final = await markEventOnTerminalFailure(helpers, eventKey, err, { contact_id: contactId, conversation_id: conversation.id, message_id: messageId });
    if (final) await dispatchAlert({ type: "event_error", channelId: channel.id, workspaceId: channel.workspace_id, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
