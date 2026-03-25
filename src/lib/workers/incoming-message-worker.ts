import type { Job } from "bullmq";
import type { IncomingMessageJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { evaluateRules } from "@/lib/rules/executor";

/**
 * Process an incoming DM from Facebook/Instagram.
 *
 * 1. Resolve Channel from pageId
 * 2. Upsert Contact + ContactChannel (dedup by platform_sender_id)
 * 3. Upsert Conversation (one per channel+contact pair)
 * 4. Insert inbound Message (dedup by platform_message_id)
 * 5. Rule engine fires in Phase 4 (auto-reply)
 */
export async function processIncomingMessage(
  job: Job<IncomingMessageJob>
): Promise<void> {
  const { pageId, senderId, mid, text, timestamp } = job.data;

  // 1. Find active channel by platform_id
  const channel = await prisma.channel.findFirst({
    where: { platform_id: pageId, is_active: true },
    select: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    await job.log(`No active channel for pageId=${pageId}, skipping`);
    return;
  }

  // 2. Upsert Contact via ContactChannel
  const existingCC = await prisma.contactChannel.findUnique({
    where: {
      channel_id_platform_sender_id: {
        channel_id: channel.id,
        platform_sender_id: senderId,
      },
    },
    select: { contact_id: true },
  });

  let contactId: string;

  if (existingCC) {
    contactId = existingCC.contact_id;
    await prisma.contact.update({
      where: { id: contactId },
      data: { last_interaction_at: new Date(timestamp * 1000) },
    });
  } else {
    const result = await prisma.$transaction(async (tx) => {
      const contact = await tx.contact.create({
        data: {
          workspace_id: channel.workspace_id,
          last_interaction_at: new Date(timestamp * 1000),
        },
      });
      await tx.contactChannel.create({
        data: {
          contact_id: contact.id,
          channel_id: channel.id,
          platform_sender_id: senderId,
        },
      });
      return contact;
    });
    contactId = result.id;
  }

  // 3. Upsert Conversation
  const conversation = await prisma.conversation.upsert({
    where: {
      channel_id_contact_id: {
        channel_id: channel.id,
        contact_id: contactId,
      },
    },
    create: {
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      contact_id: contactId,
      platform: channel.platform,
      last_message_at: new Date(timestamp * 1000),
      last_message_preview: text ? text.slice(0, 255) : null,
      unread_count: 1,
    },
    update: {
      status: "open",
      last_message_at: new Date(timestamp * 1000),
      last_message_preview: text ? text.slice(0, 255) : null,
      unread_count: { increment: 1 },
    },
    select: {
      id: true,
      is_automation_paused: true,
    },
  });

  // 4. Insert inbound Message (idempotent by platform_message_id)
  const alreadyProcessed = await prisma.message.findFirst({
    where: { platform_message_id: mid },
    select: { id: true },
  });
  if (alreadyProcessed) {
    await job.log(`mid=${mid} already processed, skipping`);
    return;
  }

  await prisma.message.create({
    data: {
      conversation_id: conversation.id,
      direction: "inbound",
      text: text ?? null,
      platform_message_id: mid,
    },
  });

  await job.log(
    `channel=${channel.id} contact=${contactId} conversation=${conversation.id} mid=${mid}`
  );

  // 5. Evaluate auto-reply rules (skip if automation is paused)
  if (!conversation.is_automation_paused) {
    const matchedRuleId = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      conversationId: conversation.id,
      contactId,
      recipientPlatformId: senderId,
      text,
      eventType: "message",
    });
    if (matchedRuleId) {
      await job.log(`Rule fired: ${matchedRuleId}`);
    }
  }
}
