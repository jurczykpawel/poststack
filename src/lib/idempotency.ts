import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { webhookEvents } from "@/db/schema";

/** A Drizzle db or an open transaction — anything that can run `.insert` / `.update`. */
type Executor = Pick<typeof db, "insert" | "update" | "query">;

/** Terminal handling outcomes a worker can claim an event with. `received` is the only
 *  non-terminal state, so it is intentionally excluded here. */
export type TerminalHandlingStatus = "fired" | "no_match" | "paused" | "ignored" | "unhandled" | "error";

/** Outcome links recorded on the webhook_events row when a worker claims the fire. All optional —
 *  a public comment reply has no contact/conversation, a no-match has no message, etc. */
export interface EventOutcomeLinks {
  contact_id?: string | null;
  conversation_id?: string | null;
  message_id?: string | null;
  comment_log_id?: string | null;
  outbound_delivery_id?: string | null;
  error_detail?: string | null;
}

/** Structured fields for a freshly-logged inbound event. `event_key` + `event_type` + `raw` are
 *  the only required fields; the rest are best-effort metadata for the log/inspection. */
export interface LogEventInput {
  event_key: string;
  event_type: string;
  raw: unknown;
  channel_id?: string | null;
  platform?: typeof webhookEvents.$inferInsert.platform;
  object?: string | null;
  field?: string | null;
  sender_id?: string | null;
  recipient_id?: string | null;
  platform_message_id?: string | null;
  is_echo?: boolean;
}

/**
 * Log an inbound event at the webhook edge: insert one `webhook_events` row in status
 * `received`, deduped on `event_key`. Returns `{ created }` — `true` when this call inserted a
 * new row (so the caller should enqueue the handler job), `false` on a redelivery (already
 * logged + already enqueued/processed → no second row, no second job). Never throws on a
 * conflict; the edge wraps this so a logging failure can never fail the webhook.
 */
export async function logEvent(input: LogEventInput, executor: Executor = db): Promise<{ created: boolean }> {
  const [row] = await executor
    .insert(webhookEvents)
    .values({
      event_key: input.event_key,
      event_type: input.event_type,
      raw: input.raw as object,
      channel_id: input.channel_id ?? null,
      platform: input.platform,
      object: input.object ?? null,
      field: input.field ?? null,
      sender_id: input.sender_id ?? null,
      recipient_id: input.recipient_id ?? null,
      platform_message_id: input.platform_message_id ?? null,
      is_echo: input.is_echo ?? false,
    })
    .onConflictDoNothing({ target: webhookEvents.event_key })
    .returning({ id: webhookEvents.id });
  return { created: row != null };
}

/**
 * Set a logged event's `handling_status` to a terminal value directly (no fire claim). Used for
 * events that are recorded but not acted on at the edge or in a worker guard: `unhandled` (no
 * handler for this type) and `ignored` (recognized but intentionally skipped — self-loop guard,
 * non-private TG chat, echo with no matching delivery). Idempotent: only transitions a row still
 * in `received`, so a redelivery is a no-op.
 */
export async function markEventStatus(
  key: string,
  status: TerminalHandlingStatus,
  links: EventOutcomeLinks = {},
  executor: Executor = db,
): Promise<void> {
  await executor
    .update(webhookEvents)
    .set({ handling_status: status, handled_at: sql`now()`, ...links })
    .where(and(eq(webhookEvents.event_key, key), eq(webhookEvents.handling_status, "received")));
}

/**
 * Atomically claim the fire for an inbound event: transition its `webhook_events` row from
 * `received` to a terminal status, recording the outcome links. Returns `true` when THIS call won
 * the claim (the caller owns the work) and `false` when the row is already terminal (a redelivery
 * or a concurrent worker already handled it). Replaces the old insert-onConflict `claimEventOnce`,
 * preserving the same at-least-once / at-most-once-fire semantics — now backed by the richer row.
 *
 * Self-sufficient: if the row is missing (a direct worker invocation that skipped the edge log),
 * it inserts a fresh terminal row (claimed). Pass an open transaction as `executor` so the claim
 * commits — or rolls back — with the rest of the fire (enqueue), so a failed reply leaves the row
 * back in `received` and the event retries cleanly.
 */
export async function claimEvent(
  key: string,
  status: TerminalHandlingStatus,
  links: EventOutcomeLinks = {},
  executor: Executor = db,
  meta: { event_type?: string; raw?: unknown } = {},
): Promise<boolean> {
  const [row] = await executor
    .insert(webhookEvents)
    .values({
      event_key: key,
      // The row should already exist (logged at the edge); these defaults only apply to a
      // direct worker invocation that skipped the edge log.
      event_type: meta.event_type ?? "unknown",
      raw: (meta.raw ?? {}) as object,
      handling_status: status,
      handled_at: sql`now()`,
      ...links,
    })
    .onConflictDoUpdate({
      target: webhookEvents.event_key,
      // Only a row still in `received` may be claimed — an already-terminal row's WHERE fails,
      // so no row is returned and the claim is correctly refused (claimed=false).
      set: { handling_status: status, handled_at: sql`now()`, ...links },
      setWhere: eq(webhookEvents.handling_status, "received"),
    })
    .returning({ id: webhookEvents.id });
  return row != null;
}

/**
 * Has this inbound event already been terminally handled? True when a row exists with a
 * `handling_status` other than `received`. Used to short-circuit a redelivery before any work.
 */
export async function isEventTerminal(key: string): Promise<boolean> {
  const row = await db.query.webhookEvents.findFirst({
    where: and(eq(webhookEvents.event_key, key), ne(webhookEvents.handling_status, "received")),
    columns: { id: true },
  });
  return row != null;
}
