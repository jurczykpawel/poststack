import { and, eq, asc, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messages, conversations, outboundDeliveries, deliveries, posts } from "@/db/schema";
import { addJob, addJobTx } from "@/lib/queue/client";
import type { TaskName, TaskPayloadMap } from "@/lib/queue/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Spacing between re-enqueued sends, to drain the backlog without a burst. */
const DRAIN_STAGGER_MS = 250;

/**
 * How many held deliveries are loaded per round. The backlog after a long outage on a high-volume
 * channel can be thousands of rows; loading them all into memory at once (plus a thousands-wide
 * conversation `inArray`) risks an OOM / a degraded query plan mid-drain. We page through
 * the backlog in keyset batches instead, keeping memory flat and each conversation lookup bounded.
 */
export const DRAIN_BATCH_SIZE = 300;

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

/** Resolve the window anchor timestamp for a held delivery, or null when undeterminable.
 *  `last_inbound_at` is read from a pre-loaded map (batched once per drain, not per held row). */
function anchorFor(
  taskName: string,
  payload: Record<string, unknown>,
  parkedAt: Date,
  lastInboundByConv: Map<string, Date | null>,
): Date | null {
  const policy = DRAIN_POLICY[taskName];
  if (!policy) return null;
  if (policy.anchor === "parked_at") return parkedAt;
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : null;
  if (conversationId) {
    const lastInbound = lastInboundByConv.get(conversationId);
    if (lastInbound) return lastInbound;
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

  let enqueued = 0;
  let expired = 0;
  // Keyset cursor over the primary key `id`: each round drains rows strictly after the last id seen.
  // Rows we re-enqueue STAY `held` (the replay job advances them), so an offset/limit would keep
  // re-reading them; the keyset walks past them, terminating in a bounded number of rounds. We page
  // by `id` (a unique uuid that binds back exactly) rather than `created_at` to sidestep timestamp
  // precision/timezone round-trip hazards; processing order within the backlog is not significant —
  // each row's window/expiry decision is independent of when it is drained.
  let cursorId: string | null = null;

  for (;;) {
    // Explicit row type: the cursor is reassigned from the last row each round, so an inferred
    // `batch` type would chase its own tail through that assignment.
    const batch: (typeof outboundDeliveries.$inferSelect)[] = await db
      .select()
      .from(outboundDeliveries)
      .where(
        and(
          eq(outboundDeliveries.status, "held"),
          eq(outboundDeliveries.channel_id, channelId),
          cursorId ? gt(outboundDeliveries.id, cursorId) : undefined,
        ),
      )
      .orderBy(asc(outboundDeliveries.id))
      .limit(DRAIN_BATCH_SIZE);
    if (batch.length === 0) break;

    // Batch-load last_inbound_at for the window-anchored conversations in THIS batch, instead of a
    // findFirst per held delivery — now bounded to the batch size, not the whole backlog.
    const convIds = [
      ...new Set(
        batch
          .filter((d) => DRAIN_POLICY[d.task_name]?.anchor === "last_inbound_at")
          .map((d) => (d.payload as Record<string, unknown> | null)?.conversationId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const convRows = convIds.length
      ? await db.select({ id: conversations.id, last_inbound_at: conversations.last_inbound_at }).from(conversations).where(inArray(conversations.id, convIds))
      : [];
    const lastInboundByConv = new Map(convRows.map((c) => [c.id, c.last_inbound_at]));

    for (const d of batch) {
      const payload = (d.payload ?? {}) as Record<string, unknown>;
      const anchor = anchorFor(d.task_name, payload, d.created_at, lastInboundByConv);
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
      // and cannot double-send. The stagger keeps growing across batches, preserving global spacing.
      await addJob(
        d.task_name as TaskName,
        payload as unknown as TaskPayloadMap[TaskName],
        { jobKey: `drain:${d.delivery_key}`, delayMs: enqueued * DRAIN_STAGGER_MS },
      );
      enqueued++;
    }

    if (batch.length < DRAIN_BATCH_SIZE) break;
    cursorId = batch[batch.length - 1].id;
  }

  // Publish-side drain (unified channel): a publish delivery parked `held` while the channel was down
  // returns to `scheduled` and is re-enqueued, mirroring the editorial post back to scheduled. The
  // `publish:<id>` jobKey + the worker's scheduled→sending CAS keep this idempotent (no double-send).
  const heldPublish = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(and(eq(deliveries.channel_id, channelId), eq(deliveries.status, "held")));
  for (const d of heldPublish) {
    await db.transaction(async (tx) => {
      await tx.update(deliveries).set({ status: "scheduled", run_at: now, updated_at: now }).where(eq(deliveries.id, d.id));
      await tx.update(posts).set({ status: "scheduled", updated_at: now }).where(eq(posts.delivery_id, d.id));
      await addJobTx(tx, "publish", { postId: d.id }, { runAt: now, jobKey: `publish:${d.id}` });
    });
    enqueued++;
  }

  return { enqueued, expired };
}
