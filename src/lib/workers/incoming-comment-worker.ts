import type { Job } from "bullmq";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by unique constraint on channel_id + platform_comment_id)
 * 3. Rule engine fires in Phase 4 (comment_keyword rules)
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
  // Rule matching for comment_keyword rules will be called from here in Phase 4+
}
