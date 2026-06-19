import { describe, it, expect } from "vitest";
import {
  formatCount,
  formatLatency,
  shouldReveal,
  selectMetrics,
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
