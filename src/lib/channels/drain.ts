import { and, eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messages, conversations, outboundDeliveries } from "@/db/schema";
import { addJob } from "@/lib/queue/client";
import type { TaskName, TaskPayloadMap } from "@/lib/queue/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Spacing between re-enqueued sends, to drain the backlog without a burst. */
const DRAIN_STAGGER_MS = 250;

/**
 * Per-operation delivery policy. A held operation is only replayed inside its window;
 * past it the operation is expired rather than sent, to avoid a policy violation.
 *
 * The standard 24h messaging window is anchored on the recipient's last inbound message
 * (`conversations.last_inbound_at`). Operations that window doesn't describe — a public
 * comment, a comment-to-DM private reply, a follow-gate re-check — use a window anchored on
 * when the operation was parked instead.
 */
type WindowAnchor = "last_inbound_at" | "parked_at";
const DRAIN_POLICY: Record<string, { windowMs: number; anchor: WindowAnchor }> = {
  "outgoing-message": { windowMs: DAY_MS, anchor: "last_inbound_at" },
  "outgoing-private-reply": { windowMs: 7 * DAY_MS, anchor: "parked_at" },
  "outgoing-comment": { windowMs: 7 * DAY_MS, anchor: "parked_at" },
  "follow-gate": { windowMs: DAY_MS, anchor: "parked_at" },
};

export interface DrainResult {
  enqueued: number;
  expired: number;
  skipped?: string;
}

/** Resolve the window anchor timestamp for a held delivery, or null when undeterminable. */
async function anchorFor(taskName: string, payload: Record<string, unknown>, parkedAt: Date): Promise<Date | null> {
  const policy = DRAIN_POLICY[taskName];
  if (!policy) return null;
  if (policy.anchor === "parked_at") return parkedAt;
  // last_inbound_at: look the conversation up by the payload's conversationId.
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null;
  if (conversationId) {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { last_inbound_at: true },
    });
    if (conv?.last_inbound_at) return conv.last_inbound_at;
  }
  // No inbound DM on this conversation (e.g. a comment-triggered DM / follow-gate reply, where
  // resolveContactConversation never sets last_inbound_at). Fall back to when it was parked so
  // the message isn't wrongly expired the moment it drains for lack of an inbound clock.
  return parkedAt;
}

/**
 * Replay outbound operations parked `held` while a channel was down. Only runs on a
 * recovered (active) channel. Each held delivery is either re-dispatched as its ORIGINAL
 * task with its ORIGINAL payload — preserving operation kind, addressing and content — or
 * marked `expired` (window elapsed). Sends are staggered to avoid a backlog burst.
 */
export async function drainChannel(channelId: string, now: Date = new Date()): Promise<DrainResult> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, status: true },
  });
  if (!channel) return { enqueued: 0, expired: 0, skipped: "not_found" };
  if (channel.status !== "active") return { enqueued: 0, expired: 0, skipped: channel.status };

  const held = await db
    .select()
    .from(outboundDeliveries)
    .where(and(eq(outboundDeliveries.status, "held"), eq(outboundDeliveries.channel_id, channelId)))
    .orderBy(asc(outboundDeliveries.created_at));

  let enqueued = 0;
  let expired = 0;

  for (const d of held) {
    const payload = (d.payload ?? {}) as Record<string, unknown>;
    const anchor = await anchorFor(d.task_name, payload, d.created_at);
    if (!anchor || now.getTime() - anchor.getTime() > (DRAIN_POLICY[d.task_name]?.windowMs ?? DAY_MS)) {
      // Expire the ledger row AND its linked inbox row in one transaction, so a failure can't
      // leave the delivery `expired` (terminal) while the message stays `held` — which would
      // peg the channel's held-count badge at a stale non-zero forever.
      await db.transaction(async (tx) => {
        if (typeof payload.heldMessageId === "string") {
          await tx.update(messages).set({ status: "expired" }).where(eq(messages.id, payload.heldMessageId));
        }
        // updated_at is stamped by the column's $onUpdate, like the messages update above.
        await tx.update(outboundDeliveries).set({ status: "expired" }).where(eq(outboundDeliveries.id, d.id));
      });
      expired++;
      continue;
    }

    // Re-dispatch the EXACT original operation. The stored payload pins `idempotencyKey` to
    // this delivery key, so the replay reuses this very ledger row (held → sending → sent)
    // and cannot double-send.
    await addJob(
      d.task_name as TaskName,
      payload as unknown as TaskPayloadMap[TaskName],
      { jobKey: `drain:${d.delivery_key}`, delayMs: enqueued * DRAIN_STAGGER_MS },
    );
    enqueued++;
  }

  return { enqueued, expired };
}
