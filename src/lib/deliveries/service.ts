import { desc, eq, and, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "@/lib/db";
import { deliveries, channels } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { encodeCursor, decodeCursor, type Cursor } from "@/lib/api/pagination";
import { getProviderForPlatform, isPublishablePlatform } from "@/lib/providers";
import { validate } from "@/lib/providers/validate";
import type { PublishRequest } from "@/lib/providers/types";
import { getMedia } from "@/lib/media/service";
import { addJobTx } from "@/lib/queue/client";

export type DeliveryRow = typeof deliveries.$inferSelect;

export interface CreateDeliveryInput {
  channelId: string;
  scheduledAt: string; // ISO
  request: PublishRequest;
  idempotencyKey?: string;
}

/** A Drizzle transaction handle (the arg passed to `db.transaction(cb)`). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Create a scheduled delivery + enqueue its publish job, scoped to a workspace. Idempotency is per
 * workspace (unique(workspace_id, idempotency_key)). When `tx` is given, the insert + outbox enqueue
 * commit on the caller's transaction; otherwise it opens its own.
 */
export async function createDelivery(input: CreateDeliveryInput, workspaceId: string, tx?: DbTx): Promise<DeliveryRow> {
  if (input.idempotencyKey) {
    const existing = await db.query.deliveries.findFirst({
      where: and(eq(deliveries.workspace_id, workspaceId), eq(deliveries.idempotency_key, input.idempotencyKey)),
    });
    if (existing) return existing;
  }

  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, input.channelId), eq(channels.workspace_id, workspaceId)),
  });
  if (!channel) throw new ApiError("not_found", "Channel not found", 404);
  if (!isPublishablePlatform(channel.platform)) {
    throw new ApiError("unsupported", `No provider for '${channel.platform}'`, 400);
  }

  const v = validate(getProviderForPlatform(channel.platform), input.request);
  if (!v.ok) throw new ApiError("invalid_request", v.errors.join("; "), 422);

  for (const m of input.request.media) {
    const exists = await getMedia(m.mediaId, workspaceId).catch(() => undefined);
    if (!exists) {
      throw new ApiError("invalid_request", `Unknown media: ${m.mediaId}`, 422);
    }
  }

  const runAt = new Date(input.scheduledAt);
  if (Number.isNaN(runAt.getTime())) {
    throw new ApiError("invalid_request", "Invalid scheduledAt", 422);
  }
  // PSA47: reject a clearly-past schedule (a generous skew window still allows when:"now").
  const PAST_SKEW_MS = 5 * 60_000;
  if (runAt.getTime() < Date.now() - PAST_SKEW_MS) {
    throw new ApiError("invalid_request", "scheduledAt is in the past", 422);
  }

  const insert = async (t: DbTx): Promise<DeliveryRow> => {
    const [row] = await t
      .insert(deliveries)
      .values({
        workspace_id: workspaceId,
        channel_id: input.channelId,
        format: input.request.format,
        status: "scheduled",
        payload: input.request,
        idempotency_key: input.idempotencyKey ?? null,
        scheduled_at: runAt,
        run_at: runAt,
      })
      .returning();
    await addJobTx(t, "publish", { postId: row!.id }, { runAt, jobKey: `publish:${row!.id}` });
    return row!;
  };

  try {
    return tx ? await insert(tx) : await db.transaction(insert);
  } catch (err) {
    // AUD32: a concurrent request with the same Idempotency-Key lost the insert race — return the winner.
    if (input.idempotencyKey && isUniqueViolation(err)) {
      const existing = await db.query.deliveries.findFirst({
        where: and(eq(deliveries.workspace_id, workspaceId), eq(deliveries.idempotency_key, input.idempotencyKey)),
      });
      if (existing) return existing;
    }
    throw err;
  }
}

export async function getDelivery(id: string, workspaceId: string): Promise<DeliveryRow | undefined> {
  return db.query.deliveries.findFirst({
    where: and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId)),
  });
}

export async function cancelDelivery(id: string, workspaceId: string): Promise<void> {
  const res = await db
    .update(deliveries)
    .set({ status: "canceled", updated_at: new Date() })
    .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId), eq(deliveries.status, "scheduled")))
    .returning({ id: deliveries.id });
  if (res.length === 0) throw new ApiError("conflict", "Post is not cancelable", 409);
}

/**
 * Re-queue a failed post (failed -> scheduled, fire now). The `status='failed'` predicate is the
 * compare-and-swap idempotency guard; the read is a friendly early-exit. `jobKey: publish:<id>` dedupes.
 */
export async function retryPost(id: string, workspaceId: string): Promise<DeliveryRow> {
  const existing = await db.query.deliveries.findFirst({
    where: and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId)),
  });
  if (!existing) throw new ApiError("not_found", "Post not found", 404);
  if (existing.status !== "failed") {
    throw new ApiError("conflict", "Post is not retryable", 409);
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(deliveries)
      .set({
        status: "scheduled",
        last_error: null,
        attempt_started_at: null,
        run_at: now,
        scheduled_at: now,
        updated_at: now,
      })
      .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId), eq(deliveries.status, "failed")))
      .returning();
    if (!row) throw new ApiError("conflict", "Post is not retryable", 409);
    await addJobTx(tx, "publish", { postId: id }, { runAt: now, jobKey: `publish:${id}` });
    return row;
  });
}

export interface ListResult {
  items: DeliveryRow[];
  nextCursor: string | null;
}

export async function listDeliveries(args: {
  workspaceId: string;
  limit: number;
  cursor?: string;
  channelId?: string;
  status?: DeliveryRow["status"];
  format?: string;
}): Promise<ListResult> {
  const cur: Cursor | null = args.cursor ? decodeCursor(args.cursor) : null;
  if (args.cursor && !cur) throw new ApiError("invalid_request", "Invalid cursor", 400);
  const filters = [
    eq(deliveries.workspace_id, args.workspaceId),
    cur
      ? sql`(${deliveries.created_at}, ${deliveries.id}) < (${cur.createdAt}::timestamptz, ${cur.id}::uuid)`
      : undefined,
    args.channelId ? eq(deliveries.channel_id, args.channelId) : undefined,
    args.status ? eq(deliveries.status, args.status) : undefined,
    args.format ? eq(deliveries.format, args.format) : undefined,
  ].filter((x): x is NonNullable<typeof x> => x !== undefined);
  const where = and(...filters);

  const rows = await db.query.deliveries.findMany({
    where,
    orderBy: [desc(deliveries.created_at), desc(deliveries.id)],
    limit: args.limit + 1,
  });
  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null,
  };
}

/** Failed posts whose last transition is within `sinceMs` (Failed·24h KPI), scoped to a workspace. */
export async function countFailedPosts(sinceMs: number, workspaceId: string): Promise<number> {
  const cutoff = new Date(Date.now() - sinceMs);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveries)
    .where(and(eq(deliveries.workspace_id, workspaceId), eq(deliveries.status, "failed"), sql`${deliveries.updated_at} > ${cutoff}`));
  return row?.n ?? 0;
}

/** Scheduled-queue KPI for a workspace: total scheduled + next future fire time. */
export async function scheduledSummary(workspaceId: string): Promise<{ count: number; nextAt: Date | null }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      nextAt: sql<string | null>`min(${deliveries.scheduled_at}) filter (where ${deliveries.scheduled_at} >= now())`,
    })
    .from(deliveries)
    .where(and(eq(deliveries.workspace_id, workspaceId), eq(deliveries.status, "scheduled")));
  return { count: row?.count ?? 0, nextAt: row?.nextAt ? new Date(row.nextAt) : null };
}
