import type { Job } from "bullmq";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decryptTokens, encryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

const IDEM_PREFIX = "idem:outmsg:";
const IDEM_TTL = 86_400; // 24 hours

/**
 * Send an outbound message via the platform API.
 *
 * Idempotency key is claimed AFTER successful send (not before)
 * so that BullMQ retries are not blocked by failed attempts.
 */
export async function processOutgoingMessage(
  job: Job<OutgoingMessageJob>
): Promise<void> {
  const { channelId, conversationId, recipientPlatformId, content, sentByRuleId, idempotencyKey } =
    job.data;

  // 1. Check idempotency (already successfully sent?)
  if (idempotencyKey) {
    const exists = await redis.get(`${IDEM_PREFIX}${idempotencyKey}`);
    if (exists) {
      await job.log(`Idempotency key ${idempotencyKey} already claimed, skipping duplicate send`);
      return;
    }
  }

  // 2. Load channel
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      platform: true,
      token_encrypted: true,
      is_active: true,
    },
  });

  if (!channel || !channel.is_active) {
    throw new Error(`Channel ${channelId} not found or inactive`);
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
        await job.log("Token refreshed on-demand before send");
      } catch (err) {
        await job.log(`Token refresh failed, using existing: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. Send via platform
  let platformMessageId: string | null = null;
  try {
    const sent = await provider.sendMessage(tokens, recipientPlatformId, content);
    platformMessageId = sent.platformMessageId;
  } catch (e) {
    // Insert failed message record so it's visible in the inbox
    await prisma.message.create({
      data: {
        conversation_id: conversationId,
        direction: "outbound",
        text: content.text ?? null,
        status: "failed",
        sent_by_rule_id: sentByRuleId ?? null,
      },
    });
    // Do NOT claim idempotency key -- allow retry
    throw e;
  }

  // 4. Claim idempotency key AFTER successful send
  if (idempotencyKey) {
    await redis.set(`${IDEM_PREFIX}${idempotencyKey}`, "1", "EX", IDEM_TTL);
  }

  // 5. Insert sent message record
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

  // 6. Update conversation preview
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      last_message_at: new Date(),
      last_message_preview: content.text ? content.text.slice(0, 255) : null,
    },
  });

  await job.log(`sent platformMessageId=${platformMessageId}`);
}
