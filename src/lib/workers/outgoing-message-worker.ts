import type { JobHelpers } from "graphile-worker";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { isClaimed, claim } from "@/lib/idempotency";
import { decryptTokens, encryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";

/**
 * Send an outbound message via the platform API.
 *
 * Idempotency key is claimed AFTER successful send (not before)
 * so that retries are not blocked by failed attempts.
 */
export async function processOutgoingMessage(
  payload: OutgoingMessageJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, recipientPlatformId, content, sentByRuleId, idempotencyKey, heldMessageId } =
    payload;

  // Park the outbound while the channel is down: a `held` message awaits drain
  // (REL5), NOT a `failed` one. On drain (heldMessageId set) the row already
  // exists, so re-parking is a no-op rather than a duplicate.
  const persistHeld = () =>
    heldMessageId
      ? Promise.resolve()
      : prisma.message.create({
          data: {
            conversation_id: conversationId,
            direction: "outbound",
            text: content.text ?? null,
            status: "held",
            sent_by_rule_id: sentByRuleId ?? null,
          },
        });

  const persistFailed = () =>
    heldMessageId
      ? prisma.message.update({ where: { id: heldMessageId }, data: { status: "failed" } })
      : prisma.message.create({
          data: {
            conversation_id: conversationId,
            direction: "outbound",
            text: content.text ?? null,
            status: "failed",
            sent_by_rule_id: sentByRuleId ?? null,
          },
        });

  // 1. Check idempotency (already successfully sent?)
  if (idempotencyKey && (await isClaimed(idempotencyKey))) {
    helpers.logger.info(`Idempotency key ${idempotencyKey} already claimed, skipping duplicate send`);
    return;
  }

  // 2. Load channel
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, platform: true, token_encrypted: true, status: true },
  });

  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }

  // Breaker open: token is known-bad, don't waste an API call that will fail.
  // Park the message as `held` (REL5) — it drains once the channel recovers.
  if (channel.status === "needs_reauth") {
    await persistHeld();
    helpers.logger.info(`Channel ${channelId} needs_reauth, message held`);
    return;
  }

  let tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);

  // On-demand token refresh if near expiry
  if (provider.requiresTokenRefresh() && tokens.expires_at) {
    const expiresAt = tokens.expires_at as number;
    const bufferSeconds = provider.refreshBufferSeconds();
    if (Date.now() / 1000 >= expiresAt - bufferSeconds) {
      try {
        tokens = await provider.refreshToken(tokens);
        await prisma.channel.update({
          where: { id: channelId },
          data: { token_encrypted: encryptTokens(tokens) },
        });
        helpers.logger.info("Token refreshed on-demand before send");
      } catch (err) {
        helpers.logger.info(`Token refresh failed, using existing: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. Send via platform
  let platformMessageId: string | null = null;
  try {
    const sent = await provider.sendMessage(tokens, recipientPlatformId, content);
    platformMessageId = sent.platformMessageId;
  } catch (e) {
    if (e instanceof TokenInvalidError) {
      // Dead token — park as `held` (REL5) and open the breaker. Do NOT retry.
      await persistHeld();
      await markChannelNeedsReauth(channelId, e.message);
      helpers.logger.info(`Channel ${channelId} token invalid on send, message held + needs_reauth`);
      return;
    }
    // Transient — record failed, do NOT claim idempotency key, allow retry.
    await persistFailed();
    throw e;
  }

  // 4. Claim idempotency key AFTER successful send
  if (idempotencyKey) {
    await claim(idempotencyKey);
  }

  // 5. Persist the sent message. On drain, update the existing held row in
  //    place; on a fresh send, insert a new record.
  if (heldMessageId) {
    await prisma.message.update({
      where: { id: heldMessageId },
      data: { status: "sent", platform_message_id: platformMessageId },
    });
  } else {
    await prisma.message.create({
      data: {
        conversation_id: conversationId,
        direction: "outbound",
        text: content.text ?? null,
        platform_message_id: platformMessageId,
        status: "sent",
        sent_by_rule_id: sentByRuleId ?? null,
      },
    });
  }

  // 6. Update conversation preview
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      last_message_at: new Date(),
      last_message_preview: content.text ? content.text.slice(0, 255) : null,
    },
  });

  helpers.logger.info(`sent platformMessageId=${platformMessageId}`);
}
