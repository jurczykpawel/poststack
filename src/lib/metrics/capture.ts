import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { responseMetrics, webhookEvents, type MetricOutcome, type ConversationThreadType, type Platform } from "@/db/schema";

/** A Drizzle db handle or an open transaction — anything that can run `.insert` / `.query`. Mirrors
 *  the `claimEvent` / rule-limit executors so the metric write commits with the terminal claim. */
type Executor = Pick<typeof db, "insert" | "query">;

/** TIMING1 handling outcomes → the metric_outcome they map to. The executor/worker terminal
 *  statuses (`fired`/`no_match`/`paused`/`ignored`/`error`) are recast to the reporting vocabulary
 *  (`fired` → `answered`); the rest pass through unchanged. */
const OUTCOME_MAP = {
  fired: "answered",
  no_match: "no_match",
  paused: "paused",
  ignored: "ignored",
  error: "error",
} as const satisfies Record<string, MetricOutcome>;

export type CaptureHandlingStatus = keyof typeof OUTCOME_MAP;

export interface RecordResponseMetricInput {
  /** webhook_events.event_key of the terminally-handled inbound event. The metric copies its
   *  id / received_at / handled_at from that row, so the row must already exist + be claimed. */
  eventKey: string;
  workspaceId: string;
  channelId: string | null;
  platform: Platform;
  threadType: ConversationThreadType;
  /** The terminal handling status, mapped to a metric_outcome. */
  status: CaptureHandlingStatus;
  /** True when the fired rule enrolled the contact into a sequence (the response rides the drip). */
  viaSequence?: boolean;
}

export interface RecordedMetric {
  /** webhook_events.id — the outbound first-response stamp carries this so the delivery can find
   *  the metric row to fill `first_response_ms`. */
  triggerEventId: string;
  /** The inbound event's received_at — the clock the first-response latency measures from. */
  triggerReceivedAt: Date;
}

/**
 * TIMING3: write one `response_metrics` row for a terminally-handled inbound event, idempotently.
 *
 * Call this from EVERY terminal handling point (the executor fire / no_match claim, a worker's
 * paused/ignored claim) — pass the SAME executor that takes the terminal claim, so the metric
 * commits atomically with the decision (or rolls back with it on a failed fire). The row copies
 * `received_at` + `handled_at` straight off the webhook_events row, so `handling_ms` is the exact
 * wall time we took to reach the terminal status. `ON CONFLICT (trigger_event_id) DO NOTHING` makes
 * a redelivery / retry a no-op (the UNIQUE on trigger_event_id is the dedup anchor).
 *
 * Returns the trigger event id + received_at to stamp on the first outbound response (TIMING2), or
 * null when the event row is missing (a direct worker invocation that skipped the edge log) — in
 * which case there is nothing to anchor a metric to and we skip rather than fabricate one.
 */
export async function recordResponseMetric(
  executor: Executor,
  input: RecordResponseMetricInput,
): Promise<RecordedMetric | null> {
  const event = await executor.query.webhookEvents.findFirst({
    where: eq(webhookEvents.event_key, input.eventKey),
    columns: { id: true, received_at: true, handled_at: true },
  });
  // No logged event (a direct/test worker invocation with no edge row) → nothing to measure.
  if (!event) return null;

  // The claim that precedes this call sets handled_at; fall back to now() defensively if a caller
  // reaches here before a terminal status was stamped (handling_ms then ~= time since received).
  const handledAt = event.handled_at ?? new Date();
  const handlingMs = Math.max(0, handledAt.getTime() - event.received_at.getTime());

  await executor
    .insert(responseMetrics)
    .values({
      workspace_id: input.workspaceId,
      channel_id: input.channelId,
      platform: input.platform,
      thread_type: input.threadType,
      trigger_event_id: event.id,
      received_at: event.received_at,
      handled_at: handledAt,
      handling_ms: handlingMs,
      outcome: OUTCOME_MAP[input.status],
      via_sequence: input.viaSequence ?? false,
    })
    .onConflictDoNothing({ target: responseMetrics.trigger_event_id });

  return { triggerEventId: event.id, triggerReceivedAt: event.received_at };
}

/**
 * TIMING4: at the outbound transition to `sent`, fill the FIRST-response latency on the metric row.
 *
 * First-write-wins + retry-safe: the `first_response_ms IS NULL` guard means only the first
 * measurable send for a trigger ever sets the value — a later sequence message, a graphile retry,
 * or a duplicate delivery is a no-op. A missing row (the metric wasn't captured) is a no-op too; we
 * never fabricate a partial metric here. The latency is clamped non-negative against clock skew.
 *
 * Pass the open transaction that marks the delivery `sent`, so the latency commits with the send.
 */
export async function recordFirstResponse(
  executor: Pick<typeof db, "update">,
  opts: { triggerEventId: string; triggerReceivedAt: Date; sentAt: Date },
): Promise<void> {
  const firstResponseMs = Math.max(0, opts.sentAt.getTime() - opts.triggerReceivedAt.getTime());
  await executor
    .update(responseMetrics)
    .set({ first_sent_at: opts.sentAt, first_response_ms: firstResponseMs })
    .where(and(eq(responseMetrics.trigger_event_id, opts.triggerEventId), isNull(responseMetrics.first_response_ms)));
}
