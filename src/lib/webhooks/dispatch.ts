import type { JobHelpers } from "graphile-worker";
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, webhookEndpoints, webhookDeliveries } from "@/db/schema";
import { addJobTx } from "@/lib/queue/client";
import { safeFetch } from "@/lib/media/ssrf";
import { redactSecrets } from "@/lib/redact";
import { getEndpoint } from "./endpoints";
import { signWebhook } from "./signature";
import type { EventDispatchJob, WebhookDeliveryJob } from "@/lib/queue/types";

/**
 * Fan one emitted event out to every active webhook endpoint in its workspace that subscribes to the
 * type (empty `event_types` = all). Endpoints only exist on Pro instances (management is gated at
 * creation), so dispatch needs no per-event license check. Idempotent: the UNIQUE (event_id,
 * endpoint_id) + onConflictDoNothing make a re-dispatch (mid-loop throw / graphile retry) a no-op —
 * the already-fanned-out endpoint inserts nothing and isn't enqueued a second time.
 */
export async function processEventDispatch(payload: EventDispatchJob, _helpers: JobHelpers): Promise<void> {
  const event = await db.query.events.findFirst({ where: eq(events.id, payload.eventId) });
  if (!event) return;

  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.workspace_id, event.workspace_id),
        eq(webhookEndpoints.active, true),
        or(
          sql`cardinality(${webhookEndpoints.event_types}) = 0`,
          sql`${event.type} = ANY(${webhookEndpoints.event_types})`,
        ),
      ),
    );
  for (const ep of endpoints) {
    await db.transaction(async (tx) => {
      const [d] = await tx
        .insert(webhookDeliveries)
        .values({ workspace_id: event.workspace_id, event_id: event.id, endpoint_id: ep.id })
        .onConflictDoNothing({ target: [webhookDeliveries.event_id, webhookDeliveries.endpoint_id] })
        .returning({ id: webhookDeliveries.id });
      if (!d) return; // already fanned out to this endpoint for this event
      await addJobTx(tx, "webhook-delivery", { deliveryId: d.id }, { maxAttempts: 8 });
    });
  }
}

/**
 * Deliver one (event, endpoint) pair: HMAC-sign the JSON body and POST it through the SSRF guard.
 * 2xx → `delivered`; any other outcome throws so graphile retries with exponential backoff, and the
 * final attempt marks the row `failed` (dead-letter). Error text is redacted before it's persisted.
 */
export async function processWebhookDelivery(payload: WebhookDeliveryJob, helpers: JobHelpers): Promise<void> {
  const delivery = await db.query.webhookDeliveries.findFirst({
    where: eq(webhookDeliveries.id, payload.deliveryId),
  });
  if (!delivery || delivery.status === "delivered") return;
  const endpoint = await getEndpoint(delivery.workspace_id, delivery.endpoint_id); // secrets decrypted at the boundary
  const event = await db.query.events.findFirst({ where: eq(events.id, delivery.event_id) });
  if (!endpoint || !event) return;

  // `id`/`type`/`created_at` describe the EVENT; `data` describes the subject it's about. `data.id`
  // is the subject's id (the contact / post / channel), so a receiver can correlate the event with
  // the REST resource (e.g. GET /api/v1/contacts/{data.id}). The event payload is merged in for the
  // event-specific extras (platform, providerHandle, …).
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    data: { id: event.subject_id, type: event.subject_type, ...(event.payload as Record<string, unknown>) },
  });
  const ts = Math.floor(Date.now() / 1000);
  const signature = signWebhook([endpoint.secret, endpoint.secret_secondary ?? ""], ts, body);

  await db
    .update(webhookDeliveries)
    .set({ status: "delivering", attempts: delivery.attempts + 1, updated_at: new Date() })
    .where(eq(webhookDeliveries.id, delivery.id));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // safeFetch runs the SSRF guard on the user-supplied URL + forces redirect:"error".
      const res = await safeFetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-PostStack-Event": event.type,
          "X-PostStack-Timestamp": String(ts),
          "X-PostStack-Signature": signature,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
    await db
      .update(webhookDeliveries)
      .set({ status: "delivered", last_error: null, updated_at: new Date() })
      .where(eq(webhookDeliveries.id, delivery.id));
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    const lastAttempt = (helpers.job?.attempts ?? 1) >= (helpers.job?.max_attempts ?? 8);
    await db
      .update(webhookDeliveries)
      .set({
        status: lastAttempt ? "failed" : "delivering",
        last_error: msg,
        updated_at: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    throw err; // graphile retries with exponential backoff
  }
}
