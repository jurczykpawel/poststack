import { describe, it, expect } from "vitest";
import {
  formatCount,
  formatLatency,
  shouldReveal,
  selectMetrics,
  selectPlatformBars,
  platformLabel,
  type FleetMetricDef,
  type FleetResponse,
} from "./fleet-stats";

describe("formatCount", () => {
  it("rounds and adds locale thousands separators", () => {
    expect(formatCount(1234)).toBe((1234).toLocaleString());
    expect(formatCount(1_234_567)).toBe((1234567).toLocaleString());
  });

  it("rounds fractional inputs to a whole number", () => {
    expect(formatCount(41.6)).toBe((42).toLocaleString());
  });

  it("formats zero", () => {
    expect(formatCount(0)).toBe((0).toLocaleString());
  });
});

describe("formatLatency", () => {
  it("renders sub-second values as ~Nms", () => {
    expect(formatLatency(420)).toBe("~420ms");
    expect(formatLatency(999)).toBe("~999ms");
  });

  it("renders sub-minute values as ~Ns", () => {
    expect(formatLatency(2000)).toBe("~2s");
    expect(formatLatency(1499)).toBe("~1s");
  });

  it("renders minute-scale values as ~Nm", () => {
    expect(formatLatency(180_000)).toBe("~3m");
  });

  it("renders null/invalid as a dash", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("shouldReveal", () => {
  it("is true only when active_instances is a finite number > 0", () => {
    expect(shouldReveal({ active_instances: 5 })).toBe(true);
    expect(shouldReveal({ active_instances: 1 })).toBe(true);
  });

  it("is false for zero instances", () => {
    expect(shouldReveal({ active_instances: 0 })).toBe(false);
  });

  it("is false for a fetch-failure shape (missing/invalid field)", () => {
    expect(shouldReveal({})).toBe(false);
    expect(shouldReveal(null)).toBe(false);
    expect(shouldReveal(undefined)).toBe(false);
    expect(shouldReveal({ active_instances: Number.NaN })).toBe(false);
    expect(shouldReveal({ active_instances: -1 })).toBe(false);
  });
});

describe("selectMetrics", () => {
  const defs: readonly FleetMetricDef[] = [
    { key: "active_instances", kind: "count" },
    { key: "total_channels", kind: "count" },
    { key: "total_messages_processed", kind: "count" },
    { key: "total_webhooks_processed", kind: "count" },
    { key: "avg_response_time_ms", kind: "duration" },
  ];

  it("formats counts and the duration row from a full response", () => {
    const stats: FleetResponse = {
      active_instances: 12,
      total_channels: 1234,
      total_messages_processed: 56_789,
      total_webhooks_processed: 90_000,
      avg_response_time_ms: 2000,
    };
    const rows = selectMetrics(stats, defs);
    expect(rows.every((r) => r.visible)).toBe(true);
    expect(rows[0]!.text).toBe((12).toLocaleString());
    expect(rows[1]!.text).toBe((1234).toLocaleString());
    expect(rows[4]!.text).toBe("~2s");
  });

  it("marks missing fields not visible (card collapses) rather than showing zeros", () => {
    const stats: FleetResponse = { active_instances: 3 };
    const rows = selectMetrics(stats, defs);
    expect(rows[0]!.visible).toBe(true);
    expect(rows[1]!.visible).toBe(false);
    expect(rows[2]!.visible).toBe(false);
    expect(rows[4]!.visible).toBe(false);
  });

  it("treats non-finite fields as not visible", () => {
    const stats = {
      active_instances: 3,
      total_channels: Number.NaN,
      avg_response_time_ms: Number.POSITIVE_INFINITY,
    } as FleetResponse;
    const rows = selectMetrics(stats, defs);
    expect(rows[1]!.visible).toBe(false);
    expect(rows[4]!.visible).toBe(false);
  });
});

describe("platformLabel", () => {
  it("special-cases known multi-case brands", () => {
    expect(platformLabel("youtube")).toBe("YouTube");
    expect(platformLabel("linkedin")).toBe("LinkedIn");
    expect(platformLabel("tiktok")).toBe("TikTok");
    expect(platformLabel("twitter")).toBe("X");
    expect(platformLabel("x")).toBe("X");
  });

  it("title-cases anything else", () => {
    expect(platformLabel("facebook")).toBe("Facebook");
    expect(platformLabel("threads")).toBe("Threads");
  });
});

describe("selectPlatformBars", () => {
  it("sorts platforms by count descending and scales bars to the leader", () => {
    const stats: FleetResponse = {
      by_platform: { instagram: 14, facebook: 24, youtube: 12 },
    };
    const bars = selectPlatformBars(stats);
    expect(bars.map((b) => b.key)).toEqual(["facebook", "instagram", "youtube"]);
    expect(bars[0]!.pct).toBe(100); // leader fills the track
    expect(bars[0]!.text).toBe((24).toLocaleString());
    expect(bars[1]!.pct).toBe(Math.round((14 / 24) * 100));
    expect(bars[0]!.label).toBe("Facebook");
  });

  it("floors tiny shares at 6% so the smallest bar stays visible", () => {
    const stats: FleetResponse = { by_platform: { facebook: 1000, threads: 1 } };
    const bars = selectPlatformBars(stats);
    expect(bars[1]!.pct).toBe(6); // 0.1% would be invisible — floored
  });

  it("drops non-positive / non-finite counts", () => {
    const stats = { by_platform: { facebook: 10, x: 0, y: -3, z: Number.NaN } } as FleetResponse;
    const bars = selectPlatformBars(stats);
    expect(bars.map((b) => b.key)).toEqual(["facebook"]);
  });

  it("respects maxBars", () => {
    const stats: FleetResponse = { by_platform: { a: 5, b: 4, c: 3, d: 2 } };
    expect(selectPlatformBars(stats, { maxBars: 2 }).map((b) => b.key)).toEqual(["a", "b"]);
  });

  it("returns [] when there is no usable platform data", () => {
    expect(selectPlatformBars({})).toEqual([]);
    expect(selectPlatformBars({ by_platform: {} })).toEqual([]);
    expect(selectPlatformBars({ by_platform: { a: 0 } })).toEqual([]);
  });
});
