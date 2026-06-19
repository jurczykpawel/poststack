// Response-time stats: the answer-rate, average-latency and percentile view over a workspace's
// handled inbound events. Reads the UNION of live `response_metrics` (recent, raw rows) and rolled-up
// `response_metric_stats` (older days, already compacted) so the numbers are identical regardless of
// how far compaction has run. The pure `summarizeMetricGroup` derivation is shared by every grouping
// (overall / by_thread_type / by_platform) and is unit-tested without a DB.

import { and, eq, gte, sql } from "drizzle-orm";
import type { db as defaultDb } from "@/lib/db";
import {
  responseMetrics,
  responseMetricStats,
  type ConversationThreadType,
  type Platform,
} from "@/db/schema";
import { BUCKET_LABELS, type BucketCounts, type BucketLabel } from "./buckets";

type Executor = typeof defaultDb;

/** Window bounds: floor 1 day, ceiling 365 — keeps a bogus/huge value from forcing a full scan. */
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 365;
export const DEFAULT_WINDOW_DAYS = 30;

/** Clamp an arbitrary (possibly NaN) window-day input into the supported range. */
export function clampWindowDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(days)));
}

/** The raw counters for one group, summed across the live + rolled-up sources. Matches the columns
 *  on response_metric_stats (a live row contributes 1 to the relevant counters). */
export interface MetricGroupCounters extends BucketCounts {
  total_count: number;
  answered_count: number;
  sum_handling_ms: number;
  count_handling: number;
  sum_first_response_ms: number;
  count_first_response: number;
}

/** The derived, presentation-ready summary of one group. */
export interface ResponseTimeSummary {
  total_count: number;
  count_first_response: number;
  /** answered / total * 100, one decimal. 0 when total is 0. */
  answer_rate_pct: number;
  /** sum_handling_ms / count_handling, rounded; null when count_handling is 0. */
  avg_handling_ms: number | null;
  /** sum_first_response_ms / count_first_response, rounded; null when no first responses. */
  avg_first_response_ms: number | null;
  /** Bucket label where the cumulative first-response count crosses 50% / 90%; null when none. */
  p50_bucket: BucketLabel | null;
  p90_bucket: BucketLabel | null;
}

/** A zeroed group accumulator. */
function emptyCounters(): MetricGroupCounters {
  return {
    total_count: 0,
    answered_count: 0,
    sum_handling_ms: 0,
    count_handling: 0,
    sum_first_response_ms: 0,
    count_first_response: 0,
    bucket_lt_1m: 0,
    bucket_lt_5m: 0,
    bucket_lt_15m: 0,
    bucket_lt_1h: 0,
    bucket_lt_6h: 0,
    bucket_lt_24h: 0,
    bucket_gte_24h: 0,
  };
}

/** Add `b` into `a` field-by-field (mutating `a`). */
function addCounters(a: MetricGroupCounters, b: MetricGroupCounters): void {
  a.total_count += b.total_count;
  a.answered_count += b.answered_count;
  a.sum_handling_ms += b.sum_handling_ms;
  a.count_handling += b.count_handling;
  a.sum_first_response_ms += b.sum_first_response_ms;
  a.count_first_response += b.count_first_response;
  for (const label of BUCKET_LABELS) a[label] += b[label];
}

/** The smallest cumulative-count threshold (rounding up) that meets a fraction of the total. */
function thresholdFor(total: number, fraction: number): number {
  return Math.ceil(total * fraction);
}

/** Walk the buckets ascending; return the label whose running cumulative count first reaches the
 *  threshold. Returns null when there are no first responses to rank. */
function percentileBucket(c: MetricGroupCounters, fraction: number): BucketLabel | null {
  if (c.count_first_response === 0) return null;
  const need = thresholdFor(c.count_first_response, fraction);
  let cumulative = 0;
  for (const label of BUCKET_LABELS) {
    cumulative += c[label];
    if (cumulative >= need) return label;
  }
  // All buckets summed still below the threshold can't happen (they sum to count_first_response),
  // but fall back to the terminal bucket to stay total.
  return "bucket_gte_24h";
}

/** Derive the presentation summary from raw counters. Pure — the unit tests pin this math. */
export function summarizeMetricGroup(c: MetricGroupCounters): ResponseTimeSummary {
  const answerRate = c.total_count === 0 ? 0 : (c.answered_count / c.total_count) * 100;
  return {
    total_count: c.total_count,
    count_first_response: c.count_first_response,
    answer_rate_pct: Math.round(answerRate * 10) / 10,
    avg_handling_ms: c.count_handling === 0 ? null : Math.round(c.sum_handling_ms / c.count_handling),
    avg_first_response_ms:
      c.count_first_response === 0 ? null : Math.round(c.sum_first_response_ms / c.count_first_response),
    p50_bucket: percentileBucket(c, 0.5),
    p90_bucket: percentileBucket(c, 0.9),
  };
}

/** Human-format a latency in ms as a compact approximate string ("~2s" / "~3m" / "~4h" / "~2d").
 *  null (no data) renders as an em-dash. Used by the dashboard tile and any operator-facing copy. */
export function formatLatencyMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return "<1s";
  const secs = ms / 1000;
  if (secs < 60) return `~${Math.round(secs)}s`;
  const mins = secs / 60;
  if (mins < 60) return `~${Math.round(mins)}m`;
  const hours = mins / 60;
  if (hours < 24) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

/** The full multi-dimensional stats payload returned by the API + dashboard. */
export interface ResponseTimeStats {
  window_days: number;
  overall: ResponseTimeSummary;
  by_thread_type: Partial<Record<ConversationThreadType, ResponseTimeSummary>>;
  by_platform: Partial<Record<Platform, ResponseTimeSummary>>;
}

/** One per-(platform,thread_type) counters row as read from either source. */
interface GroupedRow {
  platform: Platform;
  thread_type: ConversationThreadType;
  counters: MetricGroupCounters;
}

/** Build the SQL projection that turns either source into the unified MetricGroupCounters columns.
 *  `answered` collapses the live `outcome = 'answered'` flag and the rolled-up `answered_count`; the
 *  bucket columns come straight off the stats table, and from the live rows are derived by binning
 *  first_response_ms with the same thresholds as compaction (kept DRY via the CASE below). */
function liveGrouped(exec: Executor, workspaceId: string | undefined, since: Date) {
  // The bucket CASE mirrors BUCKETS exactly; the thresholds are the same constants compaction uses.
  const bucketSum = (label: BucketLabel) => {
    const ranges: Record<BucketLabel, string> = {
      bucket_lt_1m: `${responseMetrics.first_response_ms.name} < 60000`,
      bucket_lt_5m: `${responseMetrics.first_response_ms.name} >= 60000 AND ${responseMetrics.first_response_ms.name} < 300000`,
      bucket_lt_15m: `${responseMetrics.first_response_ms.name} >= 300000 AND ${responseMetrics.first_response_ms.name} < 900000`,
      bucket_lt_1h: `${responseMetrics.first_response_ms.name} >= 900000 AND ${responseMetrics.first_response_ms.name} < 3600000`,
      bucket_lt_6h: `${responseMetrics.first_response_ms.name} >= 3600000 AND ${responseMetrics.first_response_ms.name} < 21600000`,
      bucket_lt_24h: `${responseMetrics.first_response_ms.name} >= 21600000 AND ${responseMetrics.first_response_ms.name} < 86400000`,
      bucket_gte_24h: `${responseMetrics.first_response_ms.name} >= 86400000`,
    };
    return sql<number>`count(*) filter (where ${sql.raw(ranges[label])})::int`;
  };
  return exec
    .select({
      platform: responseMetrics.platform,
      thread_type: responseMetrics.thread_type,
      total_count: sql<number>`count(*)::int`,
      answered_count: sql<number>`count(*) filter (where ${responseMetrics.outcome} = 'answered')::int`,
      sum_handling_ms: sql<number>`coalesce(sum(${responseMetrics.handling_ms}), 0)::bigint`,
      count_handling: sql<number>`count(${responseMetrics.handling_ms})::int`,
      sum_first_response_ms: sql<number>`coalesce(sum(${responseMetrics.first_response_ms}), 0)::bigint`,
      count_first_response: sql<number>`count(${responseMetrics.first_response_ms})::int`,
      bucket_lt_1m: bucketSum("bucket_lt_1m"),
      bucket_lt_5m: bucketSum("bucket_lt_5m"),
      bucket_lt_15m: bucketSum("bucket_lt_15m"),
      bucket_lt_1h: bucketSum("bucket_lt_1h"),
      bucket_lt_6h: bucketSum("bucket_lt_6h"),
      bucket_lt_24h: bucketSum("bucket_lt_24h"),
      bucket_gte_24h: bucketSum("bucket_gte_24h"),
    })
    .from(responseMetrics)
    // workspaceId undefined ⇒ instance-wide (every workspace), used by anonymous telemetry; a string
    // scopes the read to one tenant. The window predicate always applies.
    .where(
      and(
        ...(workspaceId === undefined ? [] : [eq(responseMetrics.workspace_id, workspaceId)]),
        gte(responseMetrics.received_at, since),
      ),
    )
    .groupBy(responseMetrics.platform, responseMetrics.thread_type);
}

/** The rolled-up source: pre-summed counters per (platform, thread_type), filtered to the window. */
function statsGrouped(exec: Executor, workspaceId: string | undefined, sinceDay: string) {
  return exec
    .select({
      platform: responseMetricStats.platform,
      thread_type: responseMetricStats.thread_type,
      total_count: sql<number>`coalesce(sum(${responseMetricStats.total_count}), 0)::int`,
      answered_count: sql<number>`coalesce(sum(${responseMetricStats.answered_count}), 0)::int`,
      sum_handling_ms: sql<number>`coalesce(sum(${responseMetricStats.sum_handling_ms}), 0)::bigint`,
      count_handling: sql<number>`coalesce(sum(${responseMetricStats.count_handling}), 0)::int`,
      sum_first_response_ms: sql<number>`coalesce(sum(${responseMetricStats.sum_first_response_ms}), 0)::bigint`,
      count_first_response: sql<number>`coalesce(sum(${responseMetricStats.count_first_response}), 0)::int`,
      bucket_lt_1m: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_1m}), 0)::int`,
      bucket_lt_5m: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_5m}), 0)::int`,
      bucket_lt_15m: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_15m}), 0)::int`,
      bucket_lt_1h: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_1h}), 0)::int`,
      bucket_lt_6h: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_6h}), 0)::int`,
      bucket_lt_24h: sql<number>`coalesce(sum(${responseMetricStats.bucket_lt_24h}), 0)::int`,
      bucket_gte_24h: sql<number>`coalesce(sum(${responseMetricStats.bucket_gte_24h}), 0)::int`,
    })
    .from(responseMetricStats)
    .where(
      and(
        ...(workspaceId === undefined ? [] : [eq(responseMetricStats.workspace_id, workspaceId)]),
        gte(responseMetricStats.day, sinceDay),
      ),
    )
    .groupBy(responseMetricStats.platform, responseMetricStats.thread_type);
}

/** Coerce one DB row (numbers may arrive as strings from bigint/sum) into a MetricGroupCounters. */
function rowToCounters(r: Record<string, unknown>): MetricGroupCounters {
  const num = (k: string) => Number(r[k] ?? 0);
  return {
    total_count: num("total_count"),
    answered_count: num("answered_count"),
    sum_handling_ms: num("sum_handling_ms"),
    count_handling: num("count_handling"),
    sum_first_response_ms: num("sum_first_response_ms"),
    count_first_response: num("count_first_response"),
    bucket_lt_1m: num("bucket_lt_1m"),
    bucket_lt_5m: num("bucket_lt_5m"),
    bucket_lt_15m: num("bucket_lt_15m"),
    bucket_lt_1h: num("bucket_lt_1h"),
    bucket_lt_6h: num("bucket_lt_6h"),
    bucket_lt_24h: num("bucket_lt_24h"),
    bucket_gte_24h: num("bucket_gte_24h"),
  };
}

/**
 * Shared core: union the live raw metrics with the rolled-up daily stats over the trailing window and
 * derive the overall + per-thread-type + per-platform summaries. `workspaceId` undefined reads every
 * workspace (instance-wide); a string scopes to one tenant. Compaction never changes the numbers.
 */
async function computeResponseTimeStats(
  exec: Executor,
  opts: { workspaceId?: string; windowDays?: number; now?: Date },
): Promise<ResponseTimeStats> {
  const windowDays = clampWindowDays(opts.windowDays ?? DEFAULT_WINDOW_DAYS);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  // stats.day is a DATE; compare against the calendar day the window opens on (UTC).
  const sinceDay = since.toISOString().slice(0, 10);

  const [liveRows, statsRows] = await Promise.all([
    liveGrouped(exec, opts.workspaceId, since),
    statsGrouped(exec, opts.workspaceId, sinceDay),
  ]);

  const merged = new Map<string, GroupedRow>();
  const fold = (rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      const platform = r.platform as Platform;
      const thread_type = r.thread_type as ConversationThreadType;
      const key = `${platform}|${thread_type}`;
      let g = merged.get(key);
      if (!g) {
        g = { platform, thread_type, counters: emptyCounters() };
        merged.set(key, g);
      }
      addCounters(g.counters, rowToCounters(r));
    }
  };
  fold(liveRows);
  fold(statsRows);

  const overall = emptyCounters();
  const byThread = new Map<ConversationThreadType, MetricGroupCounters>();
  const byPlatform = new Map<Platform, MetricGroupCounters>();
  for (const g of merged.values()) {
    addCounters(overall, g.counters);
    const t = byThread.get(g.thread_type) ?? emptyCounters();
    addCounters(t, g.counters);
    byThread.set(g.thread_type, t);
    const p = byPlatform.get(g.platform) ?? emptyCounters();
    addCounters(p, g.counters);
    byPlatform.set(g.platform, p);
  }

  const by_thread_type: ResponseTimeStats["by_thread_type"] = {};
  for (const [k, v] of byThread) by_thread_type[k] = summarizeMetricGroup(v);
  const by_platform: ResponseTimeStats["by_platform"] = {};
  for (const [k, v] of byPlatform) by_platform[k] = summarizeMetricGroup(v);

  return {
    window_days: windowDays,
    overall: summarizeMetricGroup(overall),
    by_thread_type,
    by_platform,
  };
}

/**
 * Compute response-time stats for a single workspace over the trailing `windowDays`. Returns the
 * overall summary plus per-thread-type and per-platform breakdowns. Every query is scoped to
 * `workspaceId`.
 */
export function getResponseTimeStats(
  exec: Executor,
  opts: { workspaceId: string; windowDays?: number; now?: Date },
): Promise<ResponseTimeStats> {
  return computeResponseTimeStats(exec, opts);
}

/**
 * Instance-wide response-time stats: the same union/derivation summed across EVERY workspace, for
 * anonymous usage telemetry. No tenant scope — the numbers are deliberately aggregate, never
 * identifying any one workspace.
 */
export function getInstanceResponseTimeStats(
  exec: Executor,
  opts: { windowDays?: number; now?: Date } = {},
): Promise<ResponseTimeStats> {
  return computeResponseTimeStats(exec, opts);
}
