import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, contactChannels, conversations } from "@/db/schema";
import type { Platform } from "@/db/schema";

/**
 * Ensure a conversation row exists for (channel, contact) and return its id + automation
 * flag, WITHOUT mutating any existing row's activity/status. A brand-new row gets the
 * supplied initial timestamp/preview; an existing one is left exactly as it is — so a
 * redelivery/retry can resolve identity without reordering the inbox or reopening a
 * closed/snoozed conversation. Activity is bumped explicitly by the caller,
 * only for a genuinely new, newest event.
 */
export async function ensureConversation(
  channel: { id: string; workspace_id: string; platform: Platform },
  contactId: string,
  initial: { last_message_at: Date; last_message_preview: string | null },
): Promise<{ id: string; is_automation_paused: boolean }> {
  const [created] = await db
    .insert(conversations)
    .values({
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      contact_id: contactId,
      platform: channel.platform,
      last_message_at: initial.last_message_at,
      last_message_preview: initial.last_message_preview,
      unread_count: 0,
    })
    .onConflictDoNothing({ target: [conversations.channel_id, conversations.contact_id] })
    .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });
  if (created) return created;
  const existing = await db.query.conversations.findFirst({
    where: and(eq(conversations.channel_id, channel.id), eq(conversations.contact_id, contactId)),
    columns: { id: true, is_automation_paused: true },
  });
  return existing!;
}

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
 *
 * `reopenClosed` (default true) controls whether a fresh activity bump also flips a
 * closed/snoozed conversation back to `open`. Pass false for a LOW-signal event (a reaction):
 * it bumps activity but must not silently resurface a conversation the operator deliberately
 * closed — that would return it to the inbox with no unread/attention signal.
 *
 * NOTE on ASID vs PSID: a comment carries an app-scoped user id while a later DM from the same
 * human carries a page-scoped PSID — different strings, so they resolve to two separate contacts.
 * Linking them requires a Graph API lookup (a separate effort); until then a contact's
 * unsubscribe / erasure is per-identity. See the README "Known limitations".
 */
export async function resolveContactConversation(
  channel: { id: string; workspace_id: string; platform: Platform },
  senderId: string,
  senderName: string | null,
  preview: string | null,
  opts: { mutateActivity?: boolean; reopenClosed?: boolean } = {},
): Promise<{ contactId: string; conversationId: string; isAutomationPaused: boolean }> {
  const mutateActivity = opts.mutateActivity ?? true;
  const reopenClosed = opts.reopenClosed ?? true;

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
    // Two concurrent first events from the same NEW sender both miss the read above and race to
    // create the contact. Let the unique index on (channel_id, platform_sender_id) arbitrate via
    // onConflictDoNothing instead of letting the loser throw a 23505 that fails the job and forces a
    // retry (correct but noisy + delays the first reply by a backoff). The winner inserts both rows;
    // the loser's link insert is a no-op → we roll back its orphan contact and read the winner's id.
    const LOST_RACE = Symbol("contact-channel-race");
    try {
      contactId = await db.transaction(async (tx) => {
        const [contact] = await tx
          .insert(contacts)
          .values({ workspace_id: channel.workspace_id, display_name: senderName, last_interaction_at: new Date() })
          .returning({ id: contacts.id });
        const [link] = await tx
          .insert(contactChannels)
          .values({ contact_id: contact.id, channel_id: channel.id, platform_sender_id: senderId })
          .onConflictDoNothing({ target: [contactChannels.channel_id, contactChannels.platform_sender_id] })
          .returning({ contact_id: contactChannels.contact_id });
        if (!link) throw LOST_RACE; // roll back the orphan contact; resolve the winner below
        return link.contact_id;
      });
    } catch (err) {
      if (err !== LOST_RACE) throw err;
      const winner = await db.query.contactChannels.findFirst({
        where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
        columns: { contact_id: true },
      });
      contactId = winner!.contact_id;
    }
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
        // A low-signal event (reaction) bumps activity but leaves a deliberately closed/snoozed
        // conversation as-is — only higher-signal events reopen it.
        set: reopenClosed ? { status: "open", last_message_at: new Date() } : { last_message_at: new Date() },
      })
      .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });
    return { contactId, conversationId: conversation.id, isAutomationPaused: conversation.is_automation_paused };
  }

  // Ensure the conversation exists WITHOUT touching activity/status.
  const conversation = await ensureConversation(channel, contactId, { last_message_at: new Date(), last_message_preview: preview });
  return { contactId, conversationId: conversation.id, isAutomationPaused: conversation.is_automation_paused };
}
