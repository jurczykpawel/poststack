import type { Job } from "bullmq";
import type { OutgoingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

const IDEM_PREFIX = "idem:outcomment:";
const IDEM_TTL = 86_400;

/**
 * Post a public reply to a comment via the platform API.
 */
export async function processOutgoingComment(
  job: Job<OutgoingCommentJob>
): Promise<void> {
  const { channelId, commentId, text, sentByRuleId, idempotencyKey } = job.data;

  if (idempotencyKey) {
    const acquired = await redis.set(`${IDEM_PREFIX}${idempotencyKey}`, "1", "EX", IDEM_TTL, "NX");
    if (!acquired) {
      await job.log(`Idempotency key already claimed, skipping`);
      return;
    }
  }

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, platform: true, token_encrypted: true, is_active: true },
  });

  if (!channel || !channel.is_active) {
    throw new Error(`Channel ${channelId} not found or inactive`);
  }

  const tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);

  await provider.sendComment(tokens, commentId, text);

  // Mark comment log as reply_sent
  await prisma.commentLog.updateMany({
    where: { platform_comment_id: commentId, channel_id: channelId },
    data: { reply_sent: true, matched_rule_id: sentByRuleId ?? null },
  });

  await job.log(`Public reply sent to comment=${commentId}`);
}
