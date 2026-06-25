import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { events } from "@/db/schema";
import { addJobTx } from "@/lib/queue/client";

/**
 * Realtime hint (REALTIME1 · R1): fire a `pg_notify('realtime', …)` carrying the workspace + a coarse
 * kind + subject id. The web-process SSE hub (Phase 3) LISTENs and fans this out to workspace-scoped
 * subscribers — so the dashboard updates live with no polling. Emitting it on the same tx as the
 * write means the UI is signalled exactly when the data is committed. Best-effort: a NOTIFY failure
 * never breaks the surrounding write.
 */
export async function notifyRealtime(
  exec: { execute: typeof db.execute },
  workspaceId: string,
  kind: string,
  id: string,
): Promise<void> {
  const payload = JSON.stringify({ ws: workspaceId, kind, id });
  await exec.execute(sql`SELECT pg_notify('realtime', ${payload})`).catch(() => {});
}

/**
 * The internal event bus. Writes a workspace-scoped row to `events`; consumers (the realtime NOTIFY
 * hub — Phase 1 Task 12, and outbound webhook delivery — added later) read from it. Ported from
 * PostStack's webhooks/events, trimmed to the bus write: the webhook-dispatch job is wired when the
 * outbound-webhook subsystem lands (it reconciles with RS's alert-webhook).
 */
export const EVENT_TYPES = [
  "post.published",
  "post.held",
  "post.failed",
  "post.unknown",
  "channel.created",
  "channel.needs_reauth",
  "channel.reconnected",
  "source.connected",
  "source.synced",
  "source.needs_reauth",
  "source.data_access_expiring",
  "contact.created",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Whether `type` is a known, subscribable event type. */
export function isKnownEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type);
}

type TxLike = { insert: typeof db.insert; execute: typeof db.execute };

/** Emit an event inside the caller's transaction (outbox semantics with the surrounding write):
 *  writes the `events` row, enqueues the outbound-webhook fan-out job (WHOUT1) — both committing
 *  atomically with the surrounding write — and fires the realtime NOTIFY so the live UI is signalled
 *  on commit. The dispatch job is a no-op when no endpoint subscribes, so it's safe on every emit. */
export async function emitEvent(
  tx: TxLike,
  workspaceId: string,
  type: string,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  const [e] = await tx
    .insert(events)
    .values({ workspace_id: workspaceId, type, subject_type: subject.type, subject_id: subject.id, payload })
    .returning({ id: events.id });
  await addJobTx(tx, "event-dispatch", { eventId: e!.id });
  await notifyRealtime(tx, workspaceId, type, subject.id);
}

/** Best-effort emit outside a transaction (single-statement call sites). */
export async function emitEventNow(
  workspaceId: string,
  type: string,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  await emitEvent(db, workspaceId, type, subject, payload);
}
