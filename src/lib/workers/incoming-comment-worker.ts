import type { Job } from "bullmq";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { evaluateRules } from "@/lib/rules/executor";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by unique constraint on channel_id + platform_comment_id)
 * 3. Evaluate comment_keyword rules
 */
export async function processIncomingComment(
  job: Job<IncomingCommentJob>
): Promise<void> {
  const { pageId, commentId, postId, senderId, senderName, text } = job.data;

  if (!text) {
    await job.log(`Empty comment commentId=${commentId}, skipping`);
    return;
  }

  // 1. Find active channel
  const channel = await prisma.channel.findFirst({
    where: { platform_id: pageId, is_active: true },
    select: { id: true, workspace_id: true },
  });

  if (!channel) {
    await job.log(`No active channel for pageId=${pageId}, skipping`);
    return;
  }

  // 2. Log comment — unique constraint prevents duplicates atomically
  try {
    await prisma.commentLog.create({
      data: {
        channel_id: channel.id,
        workspace_id: channel.workspace_id,
        post_id: postId ?? null,
        platform_comment_id: commentId,
        author_id: senderId ?? null,
        author_name: senderName ?? null,
        comment_text: text,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await job.log(`commentId=${commentId} already logged (unique constraint), skipping`);
      return;
    }
    throw err;
  }

  await job.log(`Logged comment=${commentId} post=${postId} author=${senderId}`);

  // 3. Evaluate comment_keyword rules
  //    Comments don't have a conversation — senderId is the commenter.
  //    If a rule fires, it sends a DM (needs a contact + conversation for this sender).
  if (senderId) {
    // Find or skip — if this commenter has never DM'd, we don't have their contact yet.
    // The rule can only send a DM if we have an existing ContactChannel (PSID).
    const contactChannel = await prisma.contactChannel.findFirst({
      where: {
        channel_id: channel.id,
        platform_sender_id: senderId,
      },
      select: {
        contact_id: true,
        platform_sender_id: true,
      },
    });

    if (contactChannel) {
      // Find conversation for this contact+channel
      const conversation = await prisma.conversation.findFirst({
        where: {
          channel_id: channel.id,
          contact_id: contactChannel.contact_id,
        },
        select: { id: true, is_automation_paused: true },
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
          });
          if (matchedRuleId) {
            await job.log(`Comment rule fired: ${matchedRuleId}`);
          }
        } catch (err) {
          await job.log(`Rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
