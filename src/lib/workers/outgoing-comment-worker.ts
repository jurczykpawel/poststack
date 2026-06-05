import type { JobHelpers } from "graphile-worker";
import type { OutgoingCommentJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { isClaimed, claim } from "@/lib/idempotency";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";

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
  if (idempotencyKey && (await isClaimed(idempotencyKey))) {
    helpers.logger.info(`Idempotency key already claimed, skipping`);
    return;
  }

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, platform: true, token_encrypted: true, status: true },
  });

  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }

  // Breaker open: token is known-bad, don't attempt.
  if (channel.status === "needs_reauth") {
    helpers.logger.info(`Channel ${channelId} needs_reauth, not replying to comment`);
    return;
  }

  const tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);

  // Send first, claim idempotency after
  try {
    await provider.sendComment(tokens, commentId, text);
  } catch (e) {
    if (e instanceof TokenInvalidError) {
      await markChannelNeedsReauth(channelId, e.message);
      helpers.logger.info(`Channel ${channelId} token invalid on comment, flagged needs_reauth`);
      return;
    }
    throw e; // transient — allow retry
  }

  // Claim idempotency key AFTER successful send
  if (idempotencyKey) {
    await claim(idempotencyKey);
  }

  await prisma.commentLog.updateMany({
    where: { platform_comment_id: commentId, channel_id: channelId },
    data: { reply_sent: true, matched_rule_id: sentByRuleId ?? null },
  });

  helpers.logger.info(`Public reply sent to comment=${commentId}`);
}
