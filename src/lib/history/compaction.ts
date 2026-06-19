import { inArray, lt, sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import {
  webhookEvents, webhookEventStats, postReactions, postReactionStats,
  responseMetrics, responseMetricStats, type MetricOutcome,
} from "@/db/schema";

type Executor = typeof defaultDb;

/** UTC wall-clock of a Date for comparing against DB-clock `timestamp without time zone` columns
 *  (mirrors utcCutoff in maintenance.ts — avoids the process-TZ skew bug). */
const utc = (d: Date) => sql`${d.toISOString()}::timestamp`;

export interface CompactOpts {
  now: Date;
  retentionDays: number;
  batchSize: number;
  executor?: Executor;
}

export interface CompactResult { compacted: number; orphansDeleted: number }

export interface CompactHistoryResult {
  webhookEvents: CompactResult;
  postReactions: CompactResult;
  responseMetrics: CompactResult;
}

/** Fold webhook_events older than the window into webhook_event_stats, then delete the raw rows.
 *  Owned rows (channel_id NOT NULL) are aggregated; orphan rows (NULL) are deleted, never aggregated.
 *  Each batch's aggregate+delete commit atomically → a row is counted exactly once. */
export async function compactWebhookEvents(opts: CompactOpts): Promise<CompactResult> {
  const { now, retentionDays, batchSize } = opts;
  const exec = opts.executor ?? defaultDb;
  if (retentionDays <= 0) return { compacted: 0, orphansDeleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let compacted = 0, orphansDeleted = 0;

  for (;;) {
    const batch = await exec.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: webhookEvents.id,
          channel_id: webhookEvents.channel_id,
          platform: webhookEvents.platform,
          event_type: webhookEvents.event_type,
          handling_status: webhookEvents.handling_status,
          day: sql<string>`to_char(date_trunc('day', ${webhookEvents.received_at}), 'YYYY-MM-DD')`,
        })
        .from(webhookEvents)
        .where(lt(webhookEvents.received_at, utc(cutoff)))
        .orderBy(webhookEvents.received_at)
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return { n: 0, orphans: 0 };

      const agg = new Map<string, { channel_id: string; day: string; platform: typeof rows[number]["platform"]; event_type: string; handling_status: typeof rows[number]["handling_status"]; count: number }>();
      let orphans = 0;
      for (const r of rows) {
        if (r.channel_id == null) { orphans++; continue; }
        const key = `${r.channel_id}|${r.day}|${r.event_type}|${r.handling_status}`;
        const cur = agg.get(key);
        if (cur) cur.count++;
        else agg.set(key, { channel_id: r.channel_id, day: r.day, platform: r.platform, event_type: r.event_type, handling_status: r.handling_status, count: 1 });
      }
      if (agg.size > 0) {
        await tx.insert(webhookEventStats).values([...agg.values()])
          .onConflictDoUpdate({
            target: [webhookEventStats.channel_id, webhookEventStats.day, webhookEventStats.event_type, webhookEventStats.handling_status],
            set: { count: sql`${webhookEventStats.count} + excluded.count` },
          });
      }
      await tx.delete(webhookEvents).where(inArray(webhookEvents.id, rows.map((r) => r.id)));
      return { n: rows.length - orphans, orphans };
    });
    compacted += batch.n;
    orphansDeleted += batch.orphans;
    if (batch.n + batch.orphans === 0) break;
  }
  return { compacted, orphansDeleted };
}

/** Fold post_reactions older than the window into post_reaction_stats per (channel, post, type),
 *  summing counts and keeping the latest reaction timestamp. Same atomic batch contract. */
export async function compactPostReactions(opts: CompactOpts): Promise<CompactResult> {
  const { now, retentionDays, batchSize } = opts;
  const exec = opts.executor ?? defaultDb;
  if (retentionDays <= 0) return { compacted: 0, orphansDeleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let compacted = 0;

  for (;;) {
    const n = await exec.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: postReactions.id, workspace_id: postReactions.workspace_id, channel_id: postReactions.channel_id,
          post_id: postReactions.post_id, reaction_type: postReactions.reaction_type, created_at: postReactions.created_at,
        })
        .from(postReactions)
        .where(lt(postReactions.created_at, utc(cutoff)))
        .orderBy(postReactions.created_at)
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return 0;

      const agg = new Map<string, { workspace_id: string; channel_id: string; post_id: string; reaction_type: string; count: number; last_reacted_at: Date }>();
      for (const r of rows) {
        const key = `${r.channel_id}|${r.post_id}|${r.reaction_type}`;
        const cur = agg.get(key);
        if (cur) { cur.count++; if (r.created_at > cur.last_reacted_at) cur.last_reacted_at = r.created_at; }
        else agg.set(key, { workspace_id: r.workspace_id, channel_id: r.channel_id, post_id: r.post_id, reaction_type: r.reaction_type, count: 1, last_reacted_at: r.created_at });
      }
      await tx.insert(postReactionStats).values([...agg.values()])
        .onConflictDoUpdate({
          target: [postReactionStats.channel_id, postReactionStats.post_id, postReactionStats.reaction_type],
          set: {
            count: sql`${postReactionStats.count} + excluded.count`,
            last_reacted_at: sql`GREATEST(${postReactionStats.last_reacted_at}, excluded.last_reacted_at)`,
          },
        });
      await tx.delete(postReactions).where(inArray(postReactions.id, rows.map((r) => r.id)));
      return rows.length;
    });
    compacted += n;
    if (n === 0) break;
  }
  return { compacted, orphansDeleted: 0 };
}

/** A per-(workspace,day,platform,thread_type) accumulator built from a batch of raw rows. The shape
 *  matches response_metric_stats exactly so it inserts directly. min/max are null until a row with a
 *  non-null first_response_ms is seen, so an all-null group never corrupts the kept min/max. */
interface MetricAgg {
  workspace_id: string;
  day: string;
  platform: typeof responseMetrics.$inferSelect.platform;
  thread_type: typeof responseMetrics.$inferSelect.thread_type;
  answered_count: number;
  no_match_count: number;
  paused_count: number;
  ignored_count: number;
  error_count: number;
  total_count: number;
  sum_handling_ms: number;
  count_handling: number;
  sum_first_response_ms: number;
  count_first_response: number;
  min_first_response_ms: number | null;
  max_first_response_ms: number | null;
  bucket_lt_1m: number;
  bucket_lt_5m: number;
  bucket_lt_15m: number;
  bucket_lt_1h: number;
  bucket_lt_6h: number;
  bucket_lt_24h: number;
  bucket_gte_24h: number;
}

const OUTCOME_COLUMN: Record<MetricOutcome, keyof Pick<MetricAgg,
  "answered_count" | "no_match_count" | "paused_count" | "ignored_count" | "error_count">> = {
  answered: "answered_count",
  no_match: "no_match_count",
  paused: "paused_count",
  ignored: "ignored_count",
  error: "error_count",
};

/** Pick the single mutually-exclusive bucket for a first-response latency, ascending. */
function bucketColumn(ms: number): keyof Pick<MetricAgg,
  "bucket_lt_1m" | "bucket_lt_5m" | "bucket_lt_15m" | "bucket_lt_1h" | "bucket_lt_6h" | "bucket_lt_24h" | "bucket_gte_24h"> {
  if (ms < 60_000) return "bucket_lt_1m";
  if (ms < 300_000) return "bucket_lt_5m";
  if (ms < 900_000) return "bucket_lt_15m";
  if (ms < 3_600_000) return "bucket_lt_1h";
  if (ms < 21_600_000) return "bucket_lt_6h";
  if (ms < 86_400_000) return "bucket_lt_24h";
  return "bucket_gte_24h";
}

function newMetricAgg(r: Pick<MetricAgg, "workspace_id" | "day" | "platform" | "thread_type">): MetricAgg {
  return {
    ...r,
    answered_count: 0, no_match_count: 0, paused_count: 0, ignored_count: 0, error_count: 0, total_count: 0,
    sum_handling_ms: 0, count_handling: 0,
    sum_first_response_ms: 0, count_first_response: 0, min_first_response_ms: null, max_first_response_ms: null,
    bucket_lt_1m: 0, bucket_lt_5m: 0, bucket_lt_15m: 0, bucket_lt_1h: 0, bucket_lt_6h: 0, bucket_lt_24h: 0, bucket_gte_24h: 0,
  };
}

/** Fold response_metrics older than the window into response_metric_stats per
 *  (workspace, day, platform, thread_type), then delete the raw rows. Counters per outcome, handling
 *  sum/count, first-response sum/count/min/max, and a mutually-exclusive latency histogram are all
 *  ADDED to any existing rollup for the same key (a day may already be partially rolled up). Same
 *  atomic batch contract as the other compactors: aggregate + upsert + delete commit together, so a
 *  row is counted exactly once and a re-run can't double-count. */
export async function compactResponseMetrics(opts: CompactOpts): Promise<CompactResult> {
  const { now, retentionDays, batchSize } = opts;
  const exec = opts.executor ?? defaultDb;
  if (retentionDays <= 0) return { compacted: 0, orphansDeleted: 0 };
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let compacted = 0;

  for (;;) {
    const n = await exec.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: responseMetrics.id,
          workspace_id: responseMetrics.workspace_id,
          platform: responseMetrics.platform,
          thread_type: responseMetrics.thread_type,
          outcome: responseMetrics.outcome,
          handling_ms: responseMetrics.handling_ms,
          first_response_ms: responseMetrics.first_response_ms,
          day: sql<string>`to_char(date_trunc('day', ${responseMetrics.received_at}), 'YYYY-MM-DD')`,
        })
        .from(responseMetrics)
        .where(lt(responseMetrics.received_at, utc(cutoff)))
        .orderBy(responseMetrics.received_at)
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return 0;

      const agg = new Map<string, MetricAgg>();
      for (const r of rows) {
        const key = `${r.workspace_id}|${r.day}|${r.platform}|${r.thread_type}`;
        let cur = agg.get(key);
        if (!cur) { cur = newMetricAgg(r); agg.set(key, cur); }
        cur[OUTCOME_COLUMN[r.outcome]]++;
        cur.total_count++;
        cur.sum_handling_ms += r.handling_ms;
        cur.count_handling++;
        if (r.first_response_ms != null) {
          const fr = r.first_response_ms;
          cur.sum_first_response_ms += fr;
          cur.count_first_response++;
          cur.min_first_response_ms = cur.min_first_response_ms == null ? fr : Math.min(cur.min_first_response_ms, fr);
          cur.max_first_response_ms = cur.max_first_response_ms == null ? fr : Math.max(cur.max_first_response_ms, fr);
          cur[bucketColumn(fr)]++;
        }
      }

      await tx.insert(responseMetricStats).values([...agg.values()])
        .onConflictDoUpdate({
          target: [responseMetricStats.workspace_id, responseMetricStats.day, responseMetricStats.platform, responseMetricStats.thread_type],
          set: {
            answered_count: sql`${responseMetricStats.answered_count} + excluded.answered_count`,
            no_match_count: sql`${responseMetricStats.no_match_count} + excluded.no_match_count`,
            paused_count: sql`${responseMetricStats.paused_count} + excluded.paused_count`,
            ignored_count: sql`${responseMetricStats.ignored_count} + excluded.ignored_count`,
            error_count: sql`${responseMetricStats.error_count} + excluded.error_count`,
            total_count: sql`${responseMetricStats.total_count} + excluded.total_count`,
            sum_handling_ms: sql`${responseMetricStats.sum_handling_ms} + excluded.sum_handling_ms`,
            count_handling: sql`${responseMetricStats.count_handling} + excluded.count_handling`,
            sum_first_response_ms: sql`${responseMetricStats.sum_first_response_ms} + excluded.sum_first_response_ms`,
            count_first_response: sql`${responseMetricStats.count_first_response} + excluded.count_first_response`,
            // LEAST/GREATEST skip NULLs, so an all-null batch leaves the kept extremes untouched.
            min_first_response_ms: sql`LEAST(${responseMetricStats.min_first_response_ms}, excluded.min_first_response_ms)`,
            max_first_response_ms: sql`GREATEST(${responseMetricStats.max_first_response_ms}, excluded.max_first_response_ms)`,
            bucket_lt_1m: sql`${responseMetricStats.bucket_lt_1m} + excluded.bucket_lt_1m`,
            bucket_lt_5m: sql`${responseMetricStats.bucket_lt_5m} + excluded.bucket_lt_5m`,
            bucket_lt_15m: sql`${responseMetricStats.bucket_lt_15m} + excluded.bucket_lt_15m`,
            bucket_lt_1h: sql`${responseMetricStats.bucket_lt_1h} + excluded.bucket_lt_1h`,
            bucket_lt_6h: sql`${responseMetricStats.bucket_lt_6h} + excluded.bucket_lt_6h`,
            bucket_lt_24h: sql`${responseMetricStats.bucket_lt_24h} + excluded.bucket_lt_24h`,
            bucket_gte_24h: sql`${responseMetricStats.bucket_gte_24h} + excluded.bucket_gte_24h`,
          },
        });
      await tx.delete(responseMetrics).where(inArray(responseMetrics.id, rows.map((r) => r.id)));
      return rows.length;
    });
    compacted += n;
    if (n === 0) break;
  }
  return { compacted, orphansDeleted: 0 };
}

/** Run the full compaction pass (all tables). Disabled (retentionDays<=0) → every step no-ops. */
export async function compactHistory(opts: CompactOpts): Promise<CompactHistoryResult> {
  return {
    webhookEvents: await compactWebhookEvents(opts),
    postReactions: await compactPostReactions(opts),
    responseMetrics: await compactResponseMetrics(opts),
  };
}
