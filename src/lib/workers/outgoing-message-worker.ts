import type { Job } from "bullmq";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

/**
 * Send an outbound message via the platform API.
 *
 * 1. Load Channel + decrypt tokens
 * 2. Load the pending Message record
 * 3. Send via platform provider
 * 4. Update Message status to sent/failed
 */
export async function processOutgoingMessage(
  job: Job<OutgoingMessageJob>
): Promise<void> {
  const { channelId, conversationId, recipientPlatformId, content, sentByRuleId } =
    job.data;

  // 1. Load channel
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

  // 2. Send via platform
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

  // 3. Insert sent message record
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

  // 4. Update conversation preview
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      last_message_at: new Date(),
      last_message_preview: content.text ? content.text.slice(0, 255) : null,
    },
  });

  await job.log(`sent platformMessageId=${platformMessageId}`);
}
