import type { JobHelpers } from "graphile-worker";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, commentLogs, contactChannels, conversations } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by unique constraint on channel_id + platform_comment_id)
 * 3. Evaluate comment_keyword rules
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
    columns: { id: true, workspace_id: true },
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

  // 3. Evaluate comment_keyword rules
  //    Comments don't have a conversation — senderId is the commenter.
  //    If a rule fires, it sends a DM (needs a contact + conversation for this sender).
  if (senderId) {
    // Find or skip — if this commenter has never DM'd, we don't have their contact yet.
    // The rule can only send a DM if we have an existing ContactChannel (PSID).
    const contactChannel = await db.query.contactChannels.findFirst({
      where: and(eq(contactChannels.channel_id, channel.id), eq(contactChannels.platform_sender_id, senderId)),
      columns: {
        contact_id: true,
        platform_sender_id: true,
      },
    });

    if (contactChannel) {
      // Find conversation for this contact+channel
      const conversation = await db.query.conversations.findFirst({
        where: and(eq(conversations.channel_id, channel.id), eq(conversations.contact_id, contactChannel.contact_id)),
        columns: { id: true, is_automation_paused: true },
      });

      if (conversation && !conversation.is_automation_paused) {
        try {
          const matchedRuleId = await evaluateRules({
            workspaceId: channel.workspace_id,
            channelId: channel.id,
            conversationId: conversation.id,
            contactId: contactChannel.contact_id,
            recipientPlatformId: contactChannel.platform_sender_id,
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
    }
  }
}
