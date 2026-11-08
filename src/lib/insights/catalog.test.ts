import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InsightMetric, InsightsConnector } from "./types";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

// Local consumer contract, not a recorded platform response.
const watchCount: InsightMetric = {
  key: "watch_count", label: "Watches", level: "account", unit: "count", period: "day",
  grain: "day", aggregation: "sum", additive: true, definitionVersion: "test-v1",
  coverageBasis: "test-provider-day", cardOrder: 1, chartable: true,
};
const connector: InsightsConnector = {
  catalog: () => [watchCount],
  access: vi.fn(), fetch: vi.fn(), consentTransport: vi.fn(),
};

let catalog: typeof import("./catalog");
let providers: typeof import("@/lib/providers");
beforeAll(async () => {
  catalog = await import("./catalog");
  providers = await import("@/lib/providers");
});
afterEach(() => vi.restoreAllMocks());

describe("platform insights connector", () => {
  it("lets a non-Instagram provider supply a catalog through the shared interface", () => {
    const provider = providers.getProviderForPlatform("youtube");
    const insights = vi.fn((platform: string) => platform === "youtube" ? connector : undefined);
    vi.spyOn(providers.providers, "get").mockReturnValue({ ...provider, insights });
    const resolved = catalog.getInsightsConnector("youtube");
    expect(resolved).toBe(connector);
    expect(catalog.getMetric(resolved!.catalog(), "watch_count")?.aggregation).toBe("sum");
    expect(insights).toHaveBeenCalledWith("youtube");
  });

  it("returns undefined for providers without a connector and inbound-only platforms", () => {
    expect(catalog.getInsightsConnector("youtube")).toBeUndefined();
    expect(catalog.getInsightsConnector("telegram")).toBeUndefined();
  });

  it("resolves the existing aliases and keeps each Meta platform independent", () => {
    const provider = providers.getProviderForPlatform("instagram");
    const insights = vi.fn((platform: string) => platform === "instagram" ? connector : undefined);
    const get = vi.spyOn(providers.providers, "get").mockReturnValue({ ...provider, insights });
    expect(catalog.getInsightsConnector("instagram")).toBe(connector);
    expect(catalog.getInsightsConnector("facebook")).toBeUndefined();
    expect(get).toHaveBeenCalledWith("meta");
    catalog.getInsightsConnector("twitter");
    expect(get).toHaveBeenCalledWith("x");
    expect(insights).toHaveBeenCalledWith("twitter");
  });

  it("registers the implemented Instagram connector only", () => {
    expect(catalog.getInsightsConnector("instagram")).toBeDefined();
    expect(catalog.getInsightsConnector("facebook")).toBeUndefined();
  });
});

describe("metric catalog", () => {
  it("activates only the documented reach definition", async () => {
    const { instagramCatalog } = await import("./instagram/catalog");
    expect(instagramCatalog.map((m) => m.key)).toEqual(["reach"]);
    expect(catalog.getMetric(instagramCatalog, "reach")?.additive).toBe(false);
    expect(catalog.getMetric(instagramCatalog, "followers")).toBeUndefined();
  });

  it("selects only known exact keys for query construction", () => {
    const metrics = catalog.defineMetricCatalog([watchCount]);
    expect(catalog.getMetric(metrics, "watch_count")).toEqual(watchCount);
    for (const key of ["unknown", "WATCH_COUNT", "watch_count,reach", "toString", ""]) {
      expect(catalog.getMetric(metrics, key)).toBeUndefined();
    }
  });

  it("rejects duplicate keys, malformed keys and missing definition metadata", () => {
    expect(() => catalog.defineMetricCatalog([watchCount, watchCount])).toThrow();
    for (const metric of [
      { ...watchCount, key: "watch_count,reach" },
      { ...watchCount, key: "" },
      { ...watchCount, definitionVersion: " " },
      { ...watchCount, coverageBasis: "" },
    ]) expect(() => catalog.defineMetricCatalog([metric])).toThrow();
  });

  it("keeps unique range metrics non-additive without duplicating their daily definition", () => {
    const reach: InsightMetric = {
      ...watchCount, key: "unique_viewers", aggregation: "unique_range", additive: false,
    };
    expect(catalog.defineMetricCatalog([reach])).toEqual([reach]);
    expect(() => catalog.defineMetricCatalog([{ ...reach, additive: true }])).toThrow();
    expect(() => catalog.defineMetricCatalog([{ ...reach, unit: "percent" }])).toThrow();
    expect(() => catalog.defineMetricCatalog([{ ...watchCount, unit: "percent" }])).toThrow();
    expect(() => catalog.defineMetricCatalog([{ ...watchCount, additive: false }])).toThrow();
  });

  it("requires snapshots for latest-value aggregation", () => {
    const snapshot: InsightMetric = {
      ...watchCount, grain: "snapshot", period: "lifetime", aggregation: "latest_snapshot", additive: false,
    };
    expect(catalog.defineMetricCatalog([snapshot])).toEqual([snapshot]);
    expect(() => catalog.defineMetricCatalog([{ ...snapshot, grain: "day" }])).toThrow();
  });

  it("keeps canonical decimal values as exact strings", () => {
    for (const value of ["0", "19", "90071992547409931234", "0.001", "12.34"]) {
      expect(catalog.isDecimal(value)).toBe(true);
      expect(catalog.isDecimalSigned(value)).toBe(true);
    }
    expect(catalog.isDecimalSigned("-12.34")).toBe(true);
    expect(catalog.isDecimalSigned("-0.01")).toBe(true);
    for (const value of [0, null, "", "01", "1.0", "1e3", "NaN", "Infinity", "+1", " 1", "1\n", "-0"]) {
      expect(catalog.isDecimal(value)).toBe(false);
      expect(catalog.isDecimalSigned(value)).toBe(false);
    }
    expect(catalog.isDecimal("-12.34")).toBe(false);
  });
});
