import type { InsightObservation, InsightQuery } from "../types";
import { canonicalDecimal } from "./json";
import { instagramCatalog } from "./catalog";

type Context = Omit<InsightObservation, "metricKey" | "value" | "state" | "dimensions">;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid insights object");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid insights timestamp");
  if (new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error("Invalid insights date");
  return value;
}

/** Subtract a civil day with the example's offset retained; never convert to browser time. */
function previousDay(end: string): string {
  const day = new Date(Date.parse(`${end.slice(0, 10)}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return day + end.slice(10);
}

export function parseInstagramInsights(body: unknown, query: InsightQuery, context: Context): InsightObservation[] {
  const data = object(body).data;
  if (!Array.isArray(data) || data.length > 100) throw new Error("Invalid insights data");
  const observations: InsightObservation[] = [];
  for (const key of query.metrics) {
    const metric = instagramCatalog.find((m) => m.key === key);
    if (!metric) throw new Error("Unknown insights metric");
    const matches = data.map(object).filter((m) => m.name === key);
    if (matches.length > 1) throw new Error("Duplicate insights metric");
    const entry = matches[0];
    const base = { ...context, metricKey: key, dimensions: {}, definitionVersion: metric.definitionVersion, coverageBasis: metric.coverageBasis };
    if (!entry) {
      observations.push({ ...base, value: null, state: "not_available" });
      continue;
    }
    if (entry.period !== metric.period) throw new Error("Unexpected insights period");
    if (context.metricType === "total_value") {
      const total = object(entry.total_value);
      observations.push({ ...base, value: total.value === undefined ? null : canonicalDecimal(total.value), state: total.value === undefined ? "not_available" : "available", providerDay: null, boundaryBasis: "request_window_unconfirmed" });
      continue;
    }
    if (!Array.isArray(entry.values) || entry.values.length > 100) throw new Error("Invalid insights series");
    if (!entry.values.length) observations.push({ ...base, value: null, state: "not_available" });
    let previous: string | null = null;
    for (const raw of entry.values) {
      const point = object(raw);
      const end = timestamp(point.end_time);
      if (previous && Date.parse(end) <= Date.parse(previous)) throw new Error("Unordered insights series");
      const interval = previous ? Date.parse(end) - Date.parse(previous) : null;
      const first = interval === null || interval < 23 * 3600000 || interval > 25 * 3600000;
      const start = first ? previousDay(end) : previous!;
      previous = end;
      if (Date.parse(end) <= Date.parse(query.from) || Date.parse(start) >= Date.parse(query.to)) continue;
      observations.push({ ...base, windowStart: start, windowEnd: end, providerDay: start.slice(0, 10), snapshotDay: start.slice(0, 10),
        // The first point's start is estimated; per-point certainty lives only in boundaryBasis.
        boundaryBasis: first ? "provider_end_time_first_start_unconfirmed" : "provider_end_time",
        value: point.value === undefined ? null : canonicalDecimal(point.value), state: point.value === undefined ? "not_available" : "available" });
    }
  }
  return observations;
}
