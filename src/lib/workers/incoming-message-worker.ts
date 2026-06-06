import type { JobHelpers } from "graphile-worker";
import { and, eq, ne, sql } from "drizzle-orm";
import type { IncomingMessageJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { channels, contactChannels, contacts, conversations, messages } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";

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
  const { pageId, senderId, mid, text, quickReplyPayload, postbackPayload, timestamp } = payload;

  // Validate timestamp bounds (reject absurd values)
  const messageDate = new Date(timestamp * 1000);
  const now = Date.now();
  if (messageDate.getTime() > now + 86_400_000 || messageDate.getTime() < now - 30 * 86_400_000 * 365) {
    helpers.logger.info(`Invalid timestamp=${timestamp}, using current time`);
    messageDate.setTime(now);
  }

  // 1. Find active channel by platform_id
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.platform_id, pageId), ne(channels.status, "disabled")),
    columns: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${pageId}, skipping`);
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

  // 3. Upsert Conversation
  const [conversation] = await db
    .insert(conversations)
    .values({
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      contact_id: contactId,
      platform: channel.platform,
      last_message_at: messageDate,
      last_inbound_at: messageDate,
      last_message_preview: text ? text.slice(0, 255) : null,
      unread_count: 1,
    })
    .onConflictDoUpdate({
      target: [conversations.channel_id, conversations.contact_id],
      set: {
        status: "open",
        last_message_at: messageDate,
        last_inbound_at: messageDate,
        last_message_preview: text ? text.slice(0, 255) : null,
        unread_count: sql`${conversations.unread_count} + 1`,
      },
    })
    .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });

  // 4. Insert inbound Message — unique constraint on platform_message_id
  //    prevents a race (two concurrent workers for the same mid). A no-op
  //    conflict returns no row → the message was already processed.
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
    .onConflictDoNothing({ target: messages.platform_message_id })
    .returning({ id: messages.id });

  if (!inserted) {
    helpers.logger.info(`mid=${mid} already processed (unique constraint), skipping`);
    return;
  }

  helpers.logger.info(
    `channel=${channel.id} contact=${contactId} conversation=${conversation.id} mid=${mid}`
  );

  // 5. Evaluate auto-reply rules (skip if automation is paused)
  if (!conversation.is_automation_paused) {
    try {
      const matchedRuleId = await evaluateRules({
        workspaceId: channel.workspace_id,
        channelId: channel.id,
        conversationId: conversation.id,
        contactId,
        recipientPlatformId: senderId,
        text,
        eventType: "message",
        quickReplyPayload,
        postbackPayload,
      });
      if (matchedRuleId) {
        helpers.logger.info(`Rule fired: ${matchedRuleId}`);
        await db.update(conversations).set({ needs_manual_reply: false }).where(eq(conversations.id, conversation.id));
      } else {
        // No rule matched -- flag for human attention
        await db.update(conversations).set({ needs_manual_reply: true }).where(eq(conversations.id, conversation.id));
      }
    } catch (err) {
      helpers.logger.info(`Rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
