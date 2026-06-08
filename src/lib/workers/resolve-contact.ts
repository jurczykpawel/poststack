import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, contactChannels, conversations } from "@/db/schema";
import type { Platform } from "@/db/schema";

/**
 * Find-or-create the contact + conversation for a sender on a channel, keyed by
 * the platform-native sender id. Shared by the comment and reaction workers,
 * which both need to materialise a conversation before evaluating rules.
 *
 * `mutateActivity` (default true) controls whether this bumps activity — the
 * contact's `last_interaction_at` and the conversation's `last_message_at` /
 * `status = open`. Pass false on a redelivery/retry (e.g. a comment whose log
 * row already existed) so a duplicate of an old event cannot reorder the inbox
 * or reopen a closed/snoozed conversation; identity is still resolved so
 * a retry can finish a previously-failed rule evaluation on the existing rows.
 */
export async function resolveContactConversation(
  channel: { id: string; workspace_id: string; platform: Platform },
  senderId: string,
  senderName: string | null,
  preview: string | null,
  opts: { mutateActivity?: boolean } = {},
): Promise<{ contactId: string; conversationId: string; isAutomationPaused: boolean }> {
  const mutateActivity = opts.mutateActivity ?? true;

  const existingCC = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
    columns: { contact_id: true },
  });

  let contactId: string;
  if (existingCC) {
    contactId = existingCC.contact_id;
    if (mutateActivity) {
      await db.update(contacts).set({ last_interaction_at: new Date() }).where(eq(contacts.id, contactId));
    }
  } else {
    contactId = await db.transaction(async (tx) => {
      const [contact] = await tx
        .insert(contacts)
        .values({ workspace_id: channel.workspace_id, display_name: senderName, last_interaction_at: new Date() })
        .returning({ id: contacts.id });
      await tx.insert(contactChannels).values({
        contact_id: contact.id,
        channel_id: channel.id,
        platform_sender_id: senderId,
      });
      return contact.id;
    });
  }

  if (mutateActivity) {
    const [conversation] = await db
      .insert(conversations)
      .values({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        contact_id: contactId,
        platform: channel.platform,
        last_message_at: new Date(),
        last_message_preview: preview,
      })
      .onConflictDoUpdate({
        target: [conversations.channel_id, conversations.contact_id],
        set: { status: "open", last_message_at: new Date() },
      })
      .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });
    return { contactId, conversationId: conversation.id, isAutomationPaused: conversation.is_automation_paused };
  }

  // Ensure the conversation exists WITHOUT touching activity/status: a brand-new row gets
  // its initial timestamp, but an existing conversation is left exactly as it is.
  const [created] = await db
    .insert(conversations)
    .values({
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      contact_id: contactId,
      platform: channel.platform,
      last_message_at: new Date(),
      last_message_preview: preview,
    })
    .onConflictDoNothing({ target: [conversations.channel_id, conversations.contact_id] })
    .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });
  if (created) {
    return { contactId, conversationId: created.id, isAutomationPaused: created.is_automation_paused };
  }
  const existing = await db.query.conversations.findFirst({
    where: and(eq(conversations.channel_id, channel.id), eq(conversations.contact_id, contactId)),
    columns: { id: true, is_automation_paused: true },
  });
  return { contactId, conversationId: existing!.id, isAutomationPaused: existing!.is_automation_paused };
}
