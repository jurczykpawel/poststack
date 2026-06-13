import { db } from "@/lib/db";
import { events } from "@/db/schema";

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
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

/** Whether `type` is a known, subscribable event type. */
export function isKnownEventType(type: string): type is EventType {
  return EVENT_TYPE_SET.has(type);
}

type TxLike = { insert: typeof db.insert };

/** Emit an event inside the caller's transaction (outbox semantics with the surrounding write). */
export async function emitEvent(
  tx: TxLike,
  workspaceId: string,
  type: string,
  subject: { type: string; id: string },
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx
    .insert(events)
    .values({ workspace_id: workspaceId, type, subject_type: subject.type, subject_id: subject.id, payload });
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
