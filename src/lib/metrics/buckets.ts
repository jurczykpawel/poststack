// The single source of truth for the first-response latency histogram. Both the compaction rollup
// (which increments one bucket column per metric) and the stats lib (which reads the columns back
// and derives percentiles) import from here, so the thresholds, ordering and labels can never drift.

import type { responseMetricStats } from "@/db/schema";

/** A histogram bucket column on response_metric_stats, ascending by upper bound. */
export type BucketLabel =
  | "bucket_lt_1m"
  | "bucket_lt_5m"
  | "bucket_lt_15m"
  | "bucket_lt_1h"
  | "bucket_lt_6h"
  | "bucket_lt_24h"
  | "bucket_gte_24h";

/** The bucket columns in ascending order, each with its exclusive upper bound in ms. The terminal
 *  bucket (gte_24h) has no upper bound (Infinity), so a lookup always resolves. */
export const BUCKETS: ReadonlyArray<{ label: BucketLabel; ltMs: number }> = [
  { label: "bucket_lt_1m", ltMs: 60_000 },
  { label: "bucket_lt_5m", ltMs: 300_000 },
  { label: "bucket_lt_15m", ltMs: 900_000 },
  { label: "bucket_lt_1h", ltMs: 3_600_000 },
  { label: "bucket_lt_6h", ltMs: 21_600_000 },
  { label: "bucket_lt_24h", ltMs: 86_400_000 },
  { label: "bucket_gte_24h", ltMs: Number.POSITIVE_INFINITY },
] as const;

/** The bucket labels in ascending order — the canonical iteration order for percentile crossing. */
export const BUCKET_LABELS: readonly BucketLabel[] = BUCKETS.map((b) => b.label);

/** Pick the single mutually-exclusive bucket a first-response latency falls into, ascending. */
export function bucketForMs(ms: number): BucketLabel {
  for (const b of BUCKETS) {
    if (ms < b.ltMs) return b.label;
  }
  // Unreachable: the terminal bucket's bound is Infinity. Kept exhaustive for the type checker.
  return "bucket_gte_24h";
}

/** A bag of per-bucket counts keyed by label — the shape both compaction and the stats lib read. */
export type BucketCounts = Record<BucketLabel, number>;

/** The bucket columns as they appear on response_metric_stats, for type-safe column references. */
export type StatsBucketColumns = Pick<
  typeof responseMetricStats.$inferSelect,
  BucketLabel
>;
