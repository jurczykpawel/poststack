import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, contactChannels, conversations } from "@/db/schema";
import type { Platform } from "@/db/schema";

/**
 * Find-or-create the contact + conversation for a sender on a channel, keyed by
 * the platform-native sender id. Shared by the comment and reaction workers,
 * which both need to materialise a conversation before evaluating rules.
 */
export async function resolveContactConversation(
  channel: { id: string; workspace_id: string; platform: Platform },
  senderId: string,
  senderName: string | null,
  preview: string | null,
): Promise<{ contactId: string; conversationId: string; isAutomationPaused: boolean }> {
  const existingCC = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
    columns: { contact_id: true },
  });

  let contactId: string;
  if (existingCC) {
    contactId = existingCC.contact_id;
    await db.update(contacts).set({ last_interaction_at: new Date() }).where(eq(contacts.id, contactId));
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
