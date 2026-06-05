import type { JobHelpers } from "graphile-worker";
import type { OutgoingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

const IDEM_PREFIX = "idem:outcomment:";
const IDEM_TTL = 86_400;

/**
 * Post a public reply to a comment via the platform API.
 * Idempotency key claimed AFTER successful send (allows retry on failure).
 */
export async function processOutgoingComment(
  payload: OutgoingCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, commentId, text, sentByRuleId, idempotencyKey } = payload;

  // Check idempotency (already successfully sent?)
  if (idempotencyKey) {
    const exists = await redis.get(`${IDEM_PREFIX}${idempotencyKey}`);
    if (exists) {
      helpers.logger.info(`Idempotency key already claimed, skipping`);
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

  // Send first, claim idempotency after
  await provider.sendComment(tokens, commentId, text);

  // Claim idempotency key AFTER successful send
  if (idempotencyKey) {
    await redis.set(`${IDEM_PREFIX}${idempotencyKey}`, "1", "EX", IDEM_TTL);
  }

  await prisma.commentLog.updateMany({
    where: { platform_comment_id: commentId, channel_id: channelId },
    data: { reply_sent: true, matched_rule_id: sentByRuleId ?? null },
  });

  helpers.logger.info(`Public reply sent to comment=${commentId}`);
}
