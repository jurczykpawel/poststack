import type { JobHelpers } from "graphile-worker";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, outboundDeliveries, type Platform } from "@/db/schema";
import { TokenInvalidError, MessagingPolicyError, RateLimitError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";
import { addJob } from "@/lib/queue/client";
import type { TaskName, TaskPayloadMap } from "@/lib/queue/types";

/** Stop re-enqueueing a perpetually rate-limited delivery once the ledger has counted this many
 *  attempts, so it fails (dead-letters) rather than rescheduling forever. */
const RATE_LIMIT_MAX_REQUEUE = 10;

/** Upper bound on the random spread added to a rate-limit retry, so a burst that all received the
 *  same Retry-After doesn't wake as a synchronized herd and immediately re-throttle. */
const RATE_LIMIT_JITTER_CAP_MS = 30_000;

/** A Drizzle db handle or an open transaction. */
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type DeliveryTaskName = "outgoing-message" | "outgoing-comment" | "outgoing-private-reply";

/** The channel fields the delivery state machine needs. */
export interface DeliveryChannel {
  id: string;
  workspace_id: string;
  platform: Platform;
  token_encrypted: string;
  status: "active" | "needs_reauth" | "paused" | "disabled";
}

export type DeliveryResult =
  | "sent"
  | "held"
  | "dropped_policy"
  | "rate_limited"
  | "skipped_duplicate"
  | "skipped_unknown"
  | "skipped_terminal";

export interface RunDeliveryArgs {
  /** Deterministic per logical send, stable across retries of the same job. */
  deliveryKey: string;
  channelId: string;
  taskName: DeliveryTaskName;
  /** Full typed job payload, persisted so a drain can re-dispatch the exact operation. */
  payload: Record<string, unknown>;
  helpers: JobHelpers;
  /** A human's own manual reply still sends while the channel is paused. */
  allowWhenPaused?: boolean;
  /** Perform the provider send. Throw `TokenInvalidError` for a dead token, any other error for a transient failure. */
  send: (channel: DeliveryChannel) => Promise<{ platformMessageId?: string | null }>;
  /** Persist local sent-state in the SAME transaction that marks the delivery `sent` (closes the claim↔persist window). */
  onSent: (tx: Executor, platformMessageId: string | null) => Promise<void>;
  /**
   * Park local state (e.g. an inbox `held` message row) when the channel is down. Optional.
   * Return the parked message row id so the held ledger payload can point a drain replay back
   * at the same row.
   */
  onHeld?: () => Promise<{ heldMessageId?: string } | void>;
}

/** A delivery in one of these states may be (re)attempted; others are terminal. */
const REATTEMPTABLE: ReadonlySet<string> = new Set(["pending", "failed", "held"]);

/**
 * Drive one outbound send through a durable, crash-safe state machine.
 *
 * `pending → sending → sent` is the happy path; the provider call is committed-between a
 * `sending` claim and an atomic `sent`+local-persist. Two crash windows are closed:
 *  - A crash AFTER the provider accepted but BEFORE we recorded it leaves `sending`; the
 *    retry sees `sending` and refuses to re-send (→ `unknown`), so a real recipient is never
 *    sent a silent duplicate. We do not claim exactly-once across the provider boundary.
 *  - The success write and the local-state write share one transaction, so we can never end
 *    up `sent` without local state or vice-versa.
 *
 * A caught transient error records `failed` and rethrows, so graphile retries cleanly.
 */
export async function runDelivery(args: RunDeliveryArgs): Promise<DeliveryResult> {
  const { deliveryKey, channelId, taskName, payload, helpers, allowWhenPaused, send, onSent, onHeld } = args;
  // The addressed contact (DM / follow-gate carry it; public comments don't). Stamping it on
  // the ledger row gives the FK that makes a contact erasure cascade here.
  const contactId = typeof payload.contactId === "string" ? payload.contactId : null;

  // Park the send durably: record the FULL typed payload + original task on the ledger so a
  // drain can re-dispatch the exact operation later, and run the worker's local park
  // (e.g. an inbox `held` row). The stored payload pins `idempotencyKey` to this delivery key
  // (so the replay reuses this very row) and points back at the parked local row.
  const markHeld = async (workspaceId: string, lastError: string | null) => {
    const held = await onHeld?.();
    const heldPayload = {
      ...payload,
      idempotencyKey: deliveryKey,
      ...(held && held.heldMessageId ? { heldMessageId: held.heldMessageId } : {}),
    };
    await db
      .insert(outboundDeliveries)
      .values({
        delivery_key: deliveryKey,
        workspace_id: workspaceId,
        channel_id: channelId,
        contact_id: contactId,
        task_name: taskName,
        payload: heldPayload,
        status: "held",
        last_error: lastError,
        attempts: 1,
      })
      .onConflictDoUpdate({
        target: outboundDeliveries.delivery_key,
        set: { status: "held", payload: heldPayload, last_error: lastError, updated_at: new Date() },
      });
  };

  // 1. Reconcile any prior delivery for this key before doing any work.
  const prior = await db.query.outboundDeliveries.findFirst({
    where: eq(outboundDeliveries.delivery_key, deliveryKey),
  });
  if (prior) {
    if (prior.status === "sent") {
      helpers.logger.info(`delivery ${deliveryKey} already sent — skipping duplicate`);
      return "skipped_duplicate";
    }
    if (prior.status === "sending") {
      // A previous attempt committed `sending` then died before recording the outcome.
      // We cannot tell whether the provider accepted it; re-sending risks a duplicate to a
      // real recipient. Record the ambiguity and stop (at-most-once across the boundary).
      await db
        .update(outboundDeliveries)
        .set({ status: "unknown", last_error: "interrupted after dispatch" })
        .where(eq(outboundDeliveries.id, prior.id));
      helpers.logger.info(`delivery ${deliveryKey} interrupted mid-send — marked unknown, not re-sending`);
      return "skipped_unknown";
    }
    if (!REATTEMPTABLE.has(prior.status)) {
      // unknown / expired — terminal, do not resurrect.
      helpers.logger.info(`delivery ${deliveryKey} terminal (${prior.status}) — skipping`);
      return "skipped_terminal";
    }
    // pending / failed / held → fall through and (re)attempt.
  }

  // 2. Load the channel and gate on its health.
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, workspace_id: true, platform: true, token_encrypted: true, status: true },
  });
  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }
  const blockedByPause = channel.status === "paused" && !allowWhenPaused;
  if (channel.status === "needs_reauth" || blockedByPause) {
    await markHeld(channel.workspace_id, null);
    helpers.logger.info(`channel ${channelId} ${channel.status} — delivery ${deliveryKey} held`);
    return "held";
  }

  // 3. Claim the work: commit `sending` BEFORE the provider call so a crash leaves a
  //    recoverable record (the reconcile in step 1 catches it on retry).
  await db
    .insert(outboundDeliveries)
    .values({
      delivery_key: deliveryKey,
      workspace_id: channel.workspace_id,
      channel_id: channelId,
      contact_id: contactId,
      task_name: taskName,
      payload,
      status: "sending",
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: outboundDeliveries.delivery_key,
      set: { status: "sending", attempts: sql`${outboundDeliveries.attempts} + 1`, payload, updated_at: new Date() },
    });

  // 4. Send via the provider.
  let platformMessageId: string | null = null;
  try {
    const res = await send(channel);
    platformMessageId = res.platformMessageId ?? null;
  } catch (e) {
    if (e instanceof TokenInvalidError) {
      // Dead token — park (held) and open the breaker. Not retried from here. But the row is
      // currently committed `sending`; if the park/flag bookkeeping itself fails, demote it to
      // `failed` (reattemptable) and rethrow so the retry re-sends — otherwise the retry would
      // see a stuck `sending` and drop the message as an `unknown` crash.
      try {
        await markHeld(channel.workspace_id, e.message);
        await markChannelNeedsReauth(channelId, e.message);
      } catch (markErr) {
        await db
          .update(outboundDeliveries)
          .set({ status: "failed", last_error: e.message })
          .where(eq(outboundDeliveries.delivery_key, deliveryKey));
        throw markErr;
      }
      helpers.logger.info(`channel ${channelId} token invalid on ${taskName} — held + needs_reauth`);
      return "held";
    }
    if (e instanceof MessagingPolicyError) {
      // Policy rejection (e.g. outside the 24h window) — retrying can't fix it. Record a terminal
      // `expired` with the reason and DO NOT rethrow, so a stale sequence step can't grind every
      // attempt into the dead-letter queue. The ledger row is the operator-visible record.
      await db
        .update(outboundDeliveries)
        .set({ status: "expired", last_error: e.message })
        .where(eq(outboundDeliveries.delivery_key, deliveryKey));
      helpers.logger.info(`delivery ${deliveryKey} dropped — ${e.message} (not retried)`);
      return "dropped_policy";
    }
    if (e instanceof RateLimitError) {
      // The platform is throttling us. Record `failed` (reattemptable) and re-enqueue THIS exact
      // delivery at the provider's Retry-After, instead of letting graphile's short exponential
      // backoff burn the retry budget against a window that may be minutes long and dead-letter a
      // message that would otherwise go through. The stored idempotency-key makes the
      // replay reuse this very ledger row, and a deterministic jobKey collapses repeats into one
      // pending retry. Bounded by the ledger attempt count so a permanent throttle still gives up.
      await db
        .update(outboundDeliveries)
        .set({ status: "failed", last_error: e.message })
        .where(eq(outboundDeliveries.delivery_key, deliveryKey));
      const attempts = (prior?.attempts ?? 0) + 1;
      if (attempts < RATE_LIMIT_MAX_REQUEUE) {
        // Wait AT LEAST the provider's Retry-After, plus a random spread so a throttled burst that
        // all got the same value doesn't re-collide the instant the window opens. Floor the
        // spread window so a Retry-After of exactly 0 (misconfigured proxy, or a past HTTP-date under
        // clock skew) still gets non-zero jitter rather than re-colliding at delay 0.
        const jitterWindow = Math.min(Math.max(e.retryAfterMs, 1_000), RATE_LIMIT_JITTER_CAP_MS);
        const delayMs = e.retryAfterMs + Math.floor(Math.random() * jitterWindow);
        await addJob(
          taskName as TaskName,
          payload as unknown as TaskPayloadMap[TaskName],
          { jobKey: `ratelimit:${deliveryKey}`, delayMs },
        );
        helpers.logger.info(`delivery ${deliveryKey} rate-limited — retry in ~${Math.round(delayMs / 1000)}s (attempt ${attempts})`);
        return "rate_limited";
      }
      helpers.logger.info(`delivery ${deliveryKey} rate-limited past retry budget — failing`);
      throw e;
    }
    // Transient: we caught it, so the provider (most likely) did not accept the send.
    // Record `failed` and rethrow so graphile retries; the retry re-claims from `failed`.
    await db
      .update(outboundDeliveries)
      .set({ status: "failed", last_error: e instanceof Error ? e.message : String(e) })
      .where(eq(outboundDeliveries.delivery_key, deliveryKey));
    throw e;
  }

  // 5. Record success and local state atomically (closes the claim↔persist window).
  await db.transaction(async (tx) => {
    await tx
      .update(outboundDeliveries)
      .set({ status: "sent", platform_message_id: platformMessageId, last_error: null })
      .where(eq(outboundDeliveries.delivery_key, deliveryKey));
    await onSent(tx, platformMessageId);
  });

  helpers.logger.info(`delivery ${deliveryKey} sent platformMessageId=${platformMessageId}`);
  return "sent";
}
