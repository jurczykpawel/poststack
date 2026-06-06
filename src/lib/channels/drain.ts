import { and, eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messages, conversations, contactChannels } from "@/db/schema";
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
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, status: true },
  });
  if (!channel) return { enqueued: 0, expired: 0, skipped: "not_found" };
  if (channel.status !== "active") return { enqueued: 0, expired: 0, skipped: channel.status };

  const held = await db
    .select({
      id: messages.id,
      text: messages.text,
      sent_by_rule_id: messages.sent_by_rule_id,
      conv_id: conversations.id,
      contact_id: conversations.contact_id,
      last_inbound_at: conversations.last_inbound_at,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
    .where(and(eq(messages.status, "held"), eq(conversations.channel_id, channelId)))
    .orderBy(asc(messages.created_at));

  let enqueued = 0;
  let expired = 0;

  for (const msg of held) {
    const anchor = msg.last_inbound_at;
    if (!anchor || now.getTime() - anchor.getTime() > STANDARD_WINDOW_MS) {
      await db.update(messages).set({ status: "expired" }).where(eq(messages.id, msg.id));
      expired++;
      continue;
    }

    const cc = await db.query.contactChannels.findFirst({
      where: and(eq(contactChannels.channel_id, channelId), eq(contactChannels.contact_id, msg.contact_id)),
      columns: { platform_sender_id: true },
    });
    if (!cc) {
      // No way to address this contact on the channel — cannot deliver.
      await db.update(messages).set({ status: "failed" }).where(eq(messages.id, msg.id));
      continue;
    }

    await addJob(
      "outgoing-message",
      {
        channelId,
        conversationId: msg.conv_id,
        contactId: msg.contact_id,
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
