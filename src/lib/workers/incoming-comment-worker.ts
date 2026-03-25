import type { Job } from "bullmq";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by platform_comment_id)
 * 3. Rule engine fires in Phase 4 (comment_keyword rules → auto DM or reply)
 */
export async function processIncomingComment(
  job: Job<IncomingCommentJob>
): Promise<void> {
  const { pageId, commentId, postId, senderId, senderName, text, timestamp } =
    job.data;

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

  // 2. Log comment (idempotent by platform_comment_id)
  const existing = await prisma.commentLog.findFirst({
    where: { platform_comment_id: commentId },
    select: { id: true },
  });

  if (existing) {
    await job.log(`commentId=${commentId} already logged, skipping`);
    return;
  }

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

  await job.log(
    `Logged comment=${commentId} post=${postId} author=${senderId} ts=${timestamp}`
  );
  // Phase 4 will add rule matching here
}
