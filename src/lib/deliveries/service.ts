import { desc, eq, and, inArray, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "@/lib/db";
import { deliveries, channels, posts } from "@/db/schema";
import { ApiError } from "@/lib/api/response";
import { encodeCursor, decodeCursor, type Cursor } from "@/lib/api/pagination";
import { getProviderForPlatform } from "@/lib/providers";
import { can, missingPublishScopes } from "@/lib/channels/capabilities";
import { validate } from "@/lib/providers/validate";
import type { PublishRequest } from "@/lib/providers/types";
import { getMedia } from "@/lib/media/service";
import { addJobTx } from "@/lib/queue/client";

import { youtubeFormat } from "@/lib/providers/youtube-format";
import { PermanentError } from "@/lib/providers/errors";
import { assertTikTokPhotoUrls, isTikTokPhotoFormat, TIKTOK_PHOTO_DOMAIN_MSG } from "@/lib/providers/tiktok";
import { parseScheduledAt } from "./schedule";

export type DeliveryRow = typeof deliveries.$inferSelect;

export interface CreateDeliveryInput {
  channelId: string;
  scheduledAt: string; // ISO
  request: PublishRequest;
  idempotencyKey?: string;
  waitForMedia?: boolean;
}

/** A Drizzle transaction handle (the arg passed to `db.transaction(cb)`). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Validate registry media against the destination before a delivery is queued or edited. */
export async function validateDeliveryRequest(request: PublishRequest, workspaceId: string, platform: string, waitForMedia = false, channel?: { video_carousel?: string }) {
  const v = validate(getProviderForPlatform(platform), request, { platform });
  if (!v.ok) throw new ApiError("invalid_request", v.errors.join("; "), 422);

  const assets = [];
  const allowIngesting = waitForMedia && !(platform === "facebook" && request.format === "carousel");
  for (const m of request.media) {
    const exists = await getMedia(m.mediaId, workspaceId).catch(() => undefined);
    if (exists && exists.status !== "ready" && !(allowIngesting && exists.status === "ingesting")) throw new ApiError("invalid_request", `Media ${m.mediaId} is ${exists.status}; wait until ready before publishing`, 422);
    if (!exists) {
      throw new ApiError("invalid_request", `Unknown media: ${m.mediaId}`, 422);
    }
    assets.push(exists);
  }
  if (platform === "tiktok" && isTikTokPhotoFormat(request.format)) {
    const ready = assets.filter(m => m.status === "ready"); // ingesting rows have no URL yet; the provider re-checks before init
    if (ready.some(m => m.kind !== "image")) throw new ApiError("invalid_request", "TikTok photo posts accept images only", 422);
    if (ready.length) try { assertTikTokPhotoUrls(ready.map(m => m.url)); }
    catch (err) { throw new ApiError("invalid_request", err instanceof Error ? err.message : TIKTOK_PHOTO_DOMAIN_MSG, 422); }
  }
  if (["carousel", "article", "story"].includes(request.format)) {
    const checked = validate(getProviderForPlatform(platform), request, { platform, channel, mediaKinds: assets.filter(m => m.status === "ready").map(m => m.kind) });
    if (!checked.ok) throw new ApiError("invalid_request", checked.errors.join("; "), 422);
  }
  return assets;
}

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
  // Capability-gated (CHANNELS-ARCHITECTURE): the engine asks what the channel can do, never which
  // platform it is. A channel that cannot publish (e.g. an inbound-only Telegram bot) is rejected here.
  if (!can(channel, "publish")) {
    const missing = missingPublishScopes(channel);
    if (missing.length) throw new ApiError("unsupported", `Channel '${channel.display_name ?? channel.platform}' is missing permission ${missing.join(", ")} — reconnect it to publish`, 400);
    throw new ApiError("unsupported", `Channel '${channel.platform}' cannot publish`, 400);
  }

  const assets = await validateDeliveryRequest(input.request, workspaceId, channel.platform, input.waitForMedia, channel);
  try {
    if (channel.platform === "youtube") input.request.format = youtubeFormat(input.request, assets.map(m => ({ durationSec: m.duration_sec, width: m.width, height: m.height, status: m.status })));
  } catch (err) {
    if (err instanceof PermanentError) throw new ApiError("invalid_request", err.message, 422);
    throw err;
  }

  const runAt = parseScheduledAt(input.scheduledAt);

  const insert = async (t: DbTx): Promise<DeliveryRow> => {
    const [row] = await t
      .insert(deliveries)
      .values({
        workspace_id: workspaceId,
        channel_id: input.channelId,
        format: input.request.format,
        status: "scheduled",
        payload: input.request,
        tiktok_confirmation: runAt.getTime() > Date.now() ? "scheduled" : "immediate",
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
  await db.transaction(async (tx) => {
    await tx.select({ id: posts.id }).from(posts)
      .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id))).orderBy(posts.id).for("update");
    const [existing] = await tx.select({ id: deliveries.id }).from(deliveries)
      .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId)));
    if (!existing) throw new ApiError("not_found", "Delivery not found", 404);
    const [row] = await tx.update(deliveries).set({ status: "canceled", updated_at: new Date() })
      .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId), inArray(deliveries.status, ["scheduled", "held", "failed", "unknown"])))
      .returning({ id: deliveries.id });
    if (!row) throw new ApiError("conflict", "Post is not cancelable", 409);
    await tx.update(posts).set({ status: "planned", delivery_id: null, updated_at: new Date() })
      .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id)));
  });
}

/** Move a pending delivery and its linked editorial date on the same transaction as its job. */
export async function rescheduleDelivery(id: string, workspaceId: string, scheduledAt: string, tx?: DbTx): Promise<DeliveryRow> {
  const runAt = parseScheduledAt(scheduledAt);
  const run = async (t: DbTx) => {
    // Match publishPost's lock order: editorial rows before the delivery.
    await t.select({ id: posts.id }).from(posts)
      .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id))).orderBy(posts.id).for("update");
    const existing = await t.select({ id: deliveries.id }).from(deliveries)
      .where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId)));
    if (!existing.length) throw new ApiError("not_found", "Delivery not found", 404);
    const [row] = await t.update(deliveries).set({
      status: "scheduled", scheduled_at: runAt, run_at: runAt, last_error: null,
      tiktok_confirmation: "scheduled",
      attempt_started_at: null, updated_at: new Date(),
    }).where(and(eq(deliveries.id, id), eq(deliveries.workspace_id, workspaceId), inArray(deliveries.status, ["scheduled", "held"]), sql`${deliveries.tiktok_confirmation} <> 'required'`)).returning();
    if (!row) throw new ApiError("conflict", "Delivery is already publishing or no longer pending; its schedule cannot change", 409);
    await addJobTx(t, "publish", { postId: id }, { runAt, jobKey: `publish:${id}` });
    await t.update(posts).set({ scheduled_date: runAt, status: "scheduled", updated_at: new Date() })
      .where(and(eq(posts.workspace_id, workspaceId), eq(posts.delivery_id, id)));
    return row;
  };
  return tx ? run(tx) : db.transaction(run);
}

/** Uses the same job replacement and pending-state guards as changing the schedule. */
export async function publishDeliveryNow(id: string, workspaceId: string): Promise<DeliveryRow> {
  return rescheduleDelivery(id, workspaceId, new Date().toISOString());
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
        tiktok_confirmation: "scheduled",
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
