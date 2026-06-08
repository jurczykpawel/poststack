import type { JobHelpers } from "graphile-worker";
import { and, eq, lte, ne, sql } from "drizzle-orm";
import type { IncomingMessageJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, contactChannels, contacts, conversations, messages } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimOnce } from "@/lib/idempotency";
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
    columns: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for platform=${sanitizeForLog(platform)} pageId=${sanitizeForLog(pageId)} channelId=${channelId ?? "-"}, skipping`);
    return;
  }

  // 2. Upsert Contact via ContactChannel
  const existingCC = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
    columns: { contact_id: true },
  });

  let contactId: string;

  if (existingCC) {
    contactId = existingCC.contact_id;
    await db.update(contacts).set({ last_interaction_at: messageDate }).where(eq(contacts.id, contactId));
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

  // 3. Ensure the Conversation row exists and capture its id + automation flag. Stats
  //    (unread count, previews) are NOT mutated here — that happens once, only for a
  //    newly-ingested message (step 5), so a redelivery or a retry can't inflate them.
  const preview = text ? text.slice(0, 255) : null;
  const [conversation] = await db
    .insert(conversations)
    .values({
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      contact_id: contactId,
      platform: channel.platform,
      last_message_at: messageDate,
      last_inbound_at: messageDate,
      last_message_preview: preview,
      unread_count: 0,
    })
    .onConflictDoUpdate({
      target: [conversations.channel_id, conversations.contact_id],
      set: { status: "open" },
    })
    .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });

  // 4. Insert inbound Message — unique on (conversation_id, platform_message_id)
  //    prevents a race (two concurrent workers for the same mid in this conversation)
  //    and dedups a redelivery. Scoping to the conversation keeps the id from one
  //    conversation from suppressing another's message.
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

  // 5. For a newly-ingested message, bump conversation stats exactly once.
  if (isNewMessage) {
    await db.update(conversations).set({
      last_message_at: messageDate,
      last_inbound_at: messageDate,
      last_message_preview: preview,
      unread_count: sql`${conversations.unread_count} + 1`,
    }).where(eq(conversations.id, conversation.id));
    helpers.logger.info(
      `channel=${channel.id} contact=${contactId} conversation=${conversation.id} mid=${sanitizeForLog(mid)}`
    );
  } else {
    helpers.logger.info(`mid=${sanitizeForLog(mid)} already ingested — re-evaluating (idempotent via event key)`);
  }

  const eventKey = `message:${conversation.id}:${mid}`;

  // Only mutate the per-conversation manual-attention flag when THIS message is still the
  // latest activity: an old retry / late dead-letter must not overwrite a state a
  // newer message or a human reply already resolved. `last_message_at` advances on any
  // newer inbound or outbound, so this is a no-op once the conversation has moved on.
  const flagIfLatest = (needs: boolean) =>
    db.update(conversations)
      .set({ needs_manual_reply: needs })
      .where(and(eq(conversations.id, conversation.id), lte(conversations.last_message_at, messageDate)));

  // 6. Evaluate auto-reply rules. When paused, the event is still terminally claimed so a
  //    redelivery after unpause doesn't reply to an old message. Otherwise always
  //    evaluate, even on a redelivery/retry: the event key makes the rule fire at most once
  //    (claimed in the same transaction as the reply enqueue), and any failure propagates so
  //    the job is retried rather than swallowed and lost to the message dedup.
  if (conversation.is_automation_paused) {
    await claimOnce(eventKey);
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
    if (outcome === "fired") await flagIfLatest(false);
    else if (outcome === "no_match") await flagIfLatest(true);
    if (ruleId) helpers.logger.info(`Rule fired: ${ruleId}`);
  } catch (err) {
    // The auto-reply couldn't be produced/queued. Earlier attempts just retry; on the final
    // attempt the reply is permanently lost, so flag the conversation for a human before
    // rethrowing (which dead-letters the job) — otherwise the failure is silent.
    const job: { attempts: number; max_attempts: number } | undefined = helpers.job;
    if (job && job.attempts >= job.max_attempts) {
      await flagIfLatest(true);
    }
    throw err;
  }
}
