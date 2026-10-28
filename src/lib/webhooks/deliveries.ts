import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { decodeCursor, encodeCursor } from "@/lib/api/pagination";

export async function listWebhookDeliveries(workspaceId: string, endpointId: string, limit = 20, cursor?: string) {
  const endpoint = await db.query.webhookEndpoints.findFirst({
    where: and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.workspace_id, workspaceId)),
    columns: { id: true },
  });
  if (!endpoint) throw new ApiError("not_found", "Webhook endpoint not found", 404);
  const boundary = cursor === undefined ? null : decodeCursor(cursor);
  if (cursor !== undefined && !boundary) throw new ApiError("validation_error", "Invalid cursor", 422);
  const d = webhookDeliveries;
  const rows = await db.select({
    id: d.id,
    event_id: d.event_id,
    event_type: events.type,
    status: d.status,
    attempts: d.attempts,
    http_status: d.http_status,
    last_error: d.last_error,
    created_at: d.created_at,
    updated_at: d.updated_at,
    // Read the queue's actual schedule, including retry backoff, rather than estimating a date.
    next_attempt_at: sql<string | null>`case when ${d.status} in ('pending', 'delivering') then (
      select to_char(j.run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id = j.id
      where j.task_identifier = 'webhook-delivery' and p.payload->>'deliveryId' = ${d.id}::text
        and j.attempts < j.max_attempts and j.locked_at is null
      order by j.run_at limit 1
    ) end`,
  }).from(d)
    .innerJoin(events, and(eq(events.id, d.event_id), eq(events.workspace_id, workspaceId)))
    .where(and(eq(d.workspace_id, workspaceId), eq(d.endpoint_id, endpointId), boundary ? or(
      lt(d.created_at, new Date(boundary.createdAt)),
      and(eq(d.created_at, new Date(boundary.createdAt)), lt(d.id, boundary.id)),
    ) : undefined))
    .orderBy(desc(d.created_at), desc(d.id)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, meta: { has_more: hasMore, next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null } };
}
