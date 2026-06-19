import { describe, it, expect } from "vitest";
import { bucketForMs } from "./buckets";
import { summarizeMetricGroup, formatLatencyMs, clampWindowDays, type MetricGroupCounters } from "./response-times";

/** A zeroed accumulator with the optional overrides applied — keeps each case to its salient fields. */
function counters(over: Partial<MetricGroupCounters> = {}): MetricGroupCounters {
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
    ...over,
  };
}

describe("bucketForMs", () => {
  it("maps a latency to its mutually-exclusive ascending bucket", () => {
    expect(bucketForMs(0)).toBe("bucket_lt_1m");
    expect(bucketForMs(59_999)).toBe("bucket_lt_1m");
    expect(bucketForMs(60_000)).toBe("bucket_lt_5m");
    expect(bucketForMs(899_999)).toBe("bucket_lt_15m");
    expect(bucketForMs(3_600_000)).toBe("bucket_lt_6h");
    expect(bucketForMs(86_400_000)).toBe("bucket_gte_24h");
    expect(bucketForMs(99_999_999)).toBe("bucket_gte_24h");
  });
});

describe("summarizeMetricGroup", () => {
  it("derives the percentiles from the bucket histogram", () => {
    // buckets [3,1,1,0,0,0,0] over 5 first-responses: cumulative 3 (60%) at lt_1m crosses 50%;
    // cumulative 4 (80%) at lt_5m, 5 (100%) at lt_15m crosses 90%.
    const s = summarizeMetricGroup(
      counters({
        total_count: 5,
        count_first_response: 5,
        bucket_lt_1m: 3,
        bucket_lt_5m: 1,
        bucket_lt_15m: 1,
      }),
    );
    expect(s.p50_bucket).toBe("bucket_lt_1m");
    expect(s.p90_bucket).toBe("bucket_lt_15m");
  });

  it("computes answer_rate_pct to one decimal", () => {
    const s = summarizeMetricGroup(counters({ total_count: 8, answered_count: 5 }));
    expect(s.answer_rate_pct).toBe(62.5);
  });

  it("computes averages from sums and counts (integer ms, rounded)", () => {
    const s = summarizeMetricGroup(
      counters({
        total_count: 3,
        sum_handling_ms: 900,
        count_handling: 3,
        sum_first_response_ms: 1000,
        count_first_response: 3,
      }),
    );
    expect(s.avg_handling_ms).toBe(300);
    expect(s.avg_first_response_ms).toBe(333);
  });

  it("returns null percentiles + null avg when there are no first responses", () => {
    const s = summarizeMetricGroup(counters({ total_count: 4, answered_count: 0 }));
    expect(s.count_first_response).toBe(0);
    expect(s.p50_bucket).toBeNull();
    expect(s.p90_bucket).toBeNull();
    expect(s.avg_first_response_ms).toBeNull();
    expect(s.answer_rate_pct).toBe(0);
  });

  it("answer_rate_pct is 0 (not NaN) for an empty group", () => {
    const s = summarizeMetricGroup(counters());
    expect(s.answer_rate_pct).toBe(0);
    expect(s.avg_handling_ms).toBeNull();
  });

  it("p90 lands in the bucket where cumulative count first reaches 90%", () => {
    // 10 responses spread so the 9th (90%) lands in lt_1h.
    const s = summarizeMetricGroup(
      counters({
        total_count: 10,
        count_first_response: 10,
        bucket_lt_1m: 5,
        bucket_lt_5m: 2,
        bucket_lt_15m: 1,
        bucket_lt_1h: 1,
        bucket_lt_6h: 1,
      }),
    );
    expect(s.p50_bucket).toBe("bucket_lt_1m");
    expect(s.p90_bucket).toBe("bucket_lt_1h");
  });
});

describe("formatLatencyMs", () => {
  it("formats null as an em-dash", () => {
    expect(formatLatencyMs(null)).toBe("—");
  });
  it("formats sub-second, seconds, minutes, hours and days", () => {
    expect(formatLatencyMs(500)).toBe("<1s");
    expect(formatLatencyMs(2_000)).toBe("~2s");
    expect(formatLatencyMs(180_000)).toBe("~3m");
    expect(formatLatencyMs(4 * 3_600_000)).toBe("~4h");
    expect(formatLatencyMs(2 * 86_400_000)).toBe("~2d");
  });
});

describe("clampWindowDays", () => {
  it("clamps to [1, 365] and defaults a non-finite input", () => {
    expect(clampWindowDays(30)).toBe(30);
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-5)).toBe(1);
    expect(clampWindowDays(10_000)).toBe(365);
    expect(clampWindowDays(NaN)).toBe(30);
    expect(clampWindowDays(7.9)).toBe(7);
  });
});
