import type { Platform } from "@/db/schema";
import { getProviderForPlatform, isPublishablePlatform } from "@/lib/providers";
import type { Decimal, DecimalSigned, InsightMetric, InsightsConnector } from "./types";

/** Support is platform-scoped even when several platforms share a publishing provider. */
export function getInsightsConnector(platform: Platform): InsightsConnector | undefined {
  if (!isPublishablePlatform(platform)) return undefined;
  return getProviderForPlatform(platform).insights?.(platform);
}

/** An unknown key never becomes a provider query parameter or storage selector. */
export function getMetric(catalog: readonly InsightMetric[], key: string): InsightMetric | undefined {
  return catalog.find((metric) => metric.key === key);
}

/** Validate platform-owned definitions once, before exposing them to report consumers. */
export function defineMetricCatalog(metrics: readonly InsightMetric[]): readonly InsightMetric[] {
  const keys = new Set<string>();
  for (const metric of metrics) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(metric.key) || metric.key.trim() !== metric.key || keys.has(metric.key)) {
      throw new Error("Metric catalog requires unique canonical keys");
    }
    keys.add(metric.key);
    if (![metric.label, metric.definitionVersion, metric.coverageBasis].every((value) => value.trim().length > 0)) {
      throw new Error("Metric catalog requires labels and definition metadata");
    }
    const validAggregation =
      (metric.aggregation === "sum" && metric.additive && metric.unit !== "percent") ||
      (metric.aggregation === "unique_range" && !metric.additive && metric.unit === "count") ||
      (metric.aggregation === "latest_snapshot" && !metric.additive && metric.grain === "snapshot");
    if (!validAggregation) throw new Error("Metric catalog has inconsistent aggregation metadata");
  }
  return Object.freeze(metrics.map((metric) => Object.freeze({ ...metric })));
}

const decimalPattern = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

export function isDecimal(value: unknown): value is Decimal {
  return typeof value === "string" && value.trim() === value && decimalPattern.test(value);
}

export function isDecimalSigned(value: unknown): value is DecimalSigned {
  if (isDecimal(value)) return true;
  return typeof value === "string" && value.startsWith("-") && value !== "-0" && isDecimal(value.slice(1));
}
