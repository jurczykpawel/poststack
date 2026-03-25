import type { Job } from "bullmq";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

const IDEM_PREFIX = "idem:outmsg:";
const IDEM_TTL = 86_400; // 24 hours

/**
 * Send an outbound message via the platform API.
 *
 * 1. Check idempotency key (prevent duplicate sends on retry)
 * 2. Load Channel + decrypt tokens
 * 3. Send via platform provider
 * 4. Insert Message record + update conversation preview
 */
export async function processOutgoingMessage(
  job: Job<OutgoingMessageJob>
): Promise<void> {
  const { channelId, conversationId, recipientPlatformId, content, sentByRuleId, idempotencyKey } =
    job.data;

  // 1. Idempotency guard — if key exists in Redis, this is a retry of already-sent message
  if (idempotencyKey) {
    const acquired = await redis.set(
      `${IDEM_PREFIX}${idempotencyKey}`,
      "1",
      "EX",
      IDEM_TTL,
      "NX"
    );
    if (!acquired) {
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

  const tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);

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
    throw e;
  }

  // 4. Insert sent message record
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

  // 5. Update conversation preview
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      last_message_at: new Date(),
      last_message_preview: content.text ? content.text.slice(0, 255) : null,
    },
  });

  await job.log(`sent platformMessageId=${platformMessageId}`);
}
