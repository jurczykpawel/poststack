import type { JobHelpers } from "graphile-worker";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, commentLogs, contactChannels, contacts, conversations } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by unique constraint on channel_id + platform_comment_id)
 * 3. Upsert a contact + conversation for the commenter, then evaluate rules.
 *    Works first-touch: a commenter who never DM'd still gets a public reply
 *    and/or a private reply (addressed by comment_id).
 */
export async function processIncomingComment(
  payload: IncomingCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { pageId, commentId, postId, senderId, senderName, text } = payload;

  if (!text) {
    helpers.logger.info(`Empty comment commentId=${commentId}, skipping`);
    return;
  }

  // 1. Find active channel
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.platform_id, pageId), ne(channels.status, "disabled")),
    columns: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${pageId}, skipping`);
    return;
  }

  // 2. Log comment — unique constraint prevents duplicates atomically; a no-op
  //    conflict returns no row → already logged.
  const [logged] = await db
    .insert(commentLogs)
    .values({
      channel_id: channel.id,
      workspace_id: channel.workspace_id,
      post_id: postId ?? null,
      platform_comment_id: commentId,
      author_id: senderId ?? null,
      author_name: senderName ?? null,
      comment_text: text,
    })
    .onConflictDoNothing({ target: [commentLogs.channel_id, commentLogs.platform_comment_id] })
    .returning({ id: commentLogs.id });

  if (!logged) {
    helpers.logger.info(`commentId=${commentId} already logged (unique constraint), skipping`);
    return;
  }

  helpers.logger.info(`Logged comment=${commentId} post=${postId} author=${senderId}`);

  // 3. Upsert the commenter as a contact + conversation, then evaluate rules.
  //    The commenter is keyed by their comment author id. A DM reply is sent via
  //    private_replies (comment_id), so no prior messaging PSID is required.
  if (!senderId) return;

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
        .values({ workspace_id: channel.workspace_id, display_name: senderName ?? null, last_interaction_at: new Date() })
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
      last_message_preview: text.slice(0, 255),
    })
    .onConflictDoUpdate({
      target: [conversations.channel_id, conversations.contact_id],
      set: { status: "open", last_message_at: new Date() },
    })
    .returning({ id: conversations.id, is_automation_paused: conversations.is_automation_paused });

  if (conversation.is_automation_paused) {
    helpers.logger.info(`Automation paused for conversation=${conversation.id}, not replying`);
    return;
  }

  try {
    const matchedRuleId = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      conversationId: conversation.id,
      contactId,
      recipientPlatformId: senderId,
      text,
      eventType: "comment",
      postId: postId ?? undefined,
      commentId,
    });
    if (matchedRuleId) {
      helpers.logger.info(`Comment rule fired: ${matchedRuleId}`);
    }
  } catch (err) {
    helpers.logger.info(`Rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
