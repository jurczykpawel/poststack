import { prisma } from "@/lib/prisma";
import { addJob } from "@/lib/queue/client";

/**
 * Standard platform messaging window. Outbound to a user is only allowed within
 * this window measured from their last inbound message. Held messages older than
 * this are expired rather than sent, to avoid a policy violation.
 *
 * NOTE: some message types qualify for a longer window (e.g. a human-agent reply
 * extends to 7 days via the HUMAN_AGENT tag). v1 applies the conservative 24h
 * window to every held message — expiring is always safe; sending late is not.
 */
const STANDARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Spacing between re-enqueued sends, to drain the backlog without a burst. */
const DRAIN_STAGGER_MS = 250;

export interface DrainResult {
  enqueued: number;
  expired: number;
  skipped?: string;
}

/**
 * Replay outbound messages that were parked `held` while a channel was down.
 * Only runs on a recovered (active) channel. Each held message is either
 * re-enqueued for sending (still inside the messaging window) or marked
 * `expired` (window elapsed). Sends are staggered to avoid a backlog burst.
 */
export async function drainChannel(channelId: string, now: Date = new Date()): Promise<DrainResult> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, status: true },
  });
  if (!channel) return { enqueued: 0, expired: 0, skipped: "not_found" };
  if (channel.status !== "active") return { enqueued: 0, expired: 0, skipped: channel.status };

  const held = await prisma.message.findMany({
    where: { status: "held", conversation: { channel_id: channelId } },
    select: {
      id: true,
      text: true,
      sent_by_rule_id: true,
      conversation: { select: { id: true, contact_id: true, last_inbound_at: true } },
    },
    orderBy: { created_at: "asc" },
  });

  let enqueued = 0;
  let expired = 0;

  for (const msg of held) {
    const anchor = msg.conversation.last_inbound_at;
    if (!anchor || now.getTime() - anchor.getTime() > STANDARD_WINDOW_MS) {
      await prisma.message.update({ where: { id: msg.id }, data: { status: "expired" } });
      expired++;
      continue;
    }

    const cc = await prisma.contactChannel.findFirst({
      where: { channel_id: channelId, contact_id: msg.conversation.contact_id },
      select: { platform_sender_id: true },
    });
    if (!cc) {
      // No way to address this contact on the channel — cannot deliver.
      await prisma.message.update({ where: { id: msg.id }, data: { status: "failed" } });
      continue;
    }

    await addJob(
      "outgoing-message",
      {
        channelId,
        conversationId: msg.conversation.id,
        contactId: msg.conversation.contact_id,
        recipientPlatformId: cc.platform_sender_id,
        content: { text: msg.text ?? undefined },
        sentByRuleId: msg.sent_by_rule_id ?? undefined,
        heldMessageId: msg.id,
        idempotencyKey: `held:${msg.id}`,
      },
      { jobKey: `drain-msg:${msg.id}`, delayMs: enqueued * DRAIN_STAGGER_MS },
    );
    enqueued++;
  }

  return { enqueued, expired };
}
