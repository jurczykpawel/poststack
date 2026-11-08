import { describe, expect, it } from "vitest";
import series from "../__fixtures__/instagram/account-series.json";
import total from "../__fixtures__/instagram/account-total-example.json";
import { parseInsightJson } from "./json";
import { parseInstagramInsights } from "./parser";
import { instagramCatalog } from "./catalog";
import type { InsightObservation, InsightQuery } from "../types";

const query: InsightQuery = { level: "account", subjectKey: "account", from: "2018-01-10T08:00:00Z", to: "2018-01-12T08:00:00Z", metrics: ["reach"], grain: "day" };
const context: Omit<InsightObservation, "metricKey" | "value" | "state" | "dimensions"> = {
  platform: "instagram", level: "account", subjectKey: "account", grain: "day", period: "day", metricType: "time_series",
  windowStart: query.from, windowEnd: query.to, snapshotDay: "2018-01-12", fetchedAt: "2018-01-13T00:00:00Z",
  providerDay: null, boundaryBasis: "provider_end_time", queryParams: {}, transport: "facebook", apiVersion: "v26.0", definitionVersion: "reach-v1", coverageBasis: "provider_end_time",
};
const body = () => parseInsightJson(series.responseText);
function mutated(value: unknown) {
  // Validation mutation of the official account response, not a platform success fixture.
  const copy = JSON.parse(series.responseText);
  copy.data = [copy.data.find((m: { name: string }) => m.name === "reach")];
  copy.data[0].values[0].value = value;
  return copy;
}
describe("Instagram account normalization", () => {
  it("reads the exact account example and retains 08:00 UTC provider boundaries", () => {
    const parsed = parseInstagramInsights(body(), query, context);
    expect(parsed.map((p) => p.value)).toEqual(["12", "12"]);
    expect(parsed[0]).toMatchObject({ period: "day", windowStart: "2018-01-10T08:00:00+0000", windowEnd: "2018-01-11T08:00:00+0000", providerDay: "2018-01-10" });
    // Only the boundary differs per point; the definition-level coverage stays the catalog's.
    expect(parsed.map((p) => p.boundaryBasis)).toEqual(["provider_end_time_first_start_unconfirmed", "provider_end_time"]);
    expect(parsed.map((p) => p.coverageBasis)).toEqual([instagramCatalog[0].coverageBasis, instagramCatalog[0].coverageBasis]);
    expect(series.provenance).toBe("documentation");
  });
  it("keeps the malformed total example verbatim and rejects it", () => {
    expect(total.provenance).toBe("documentation");
    expect(() => parseInsightJson(total.responseText)).toThrow();
  });
  it("distinguishes absent data from an explicit zero, preserving large integers", () => {
    expect(parseInstagramInsights(mutated("9007199254740993"), query, context)[0].value).toBe("9007199254740993");
    expect(parseInstagramInsights(mutated(0), query, context)[0].value).toBe("0");
    // Omission mutations of the official example.
    for (const data of [[], [{ name: "different_metric", period: "day" }]]) {
      expect(parseInstagramInsights({ data }, query, context)[0]).toMatchObject({ value: null, state: "not_available" });
    }
  });
  it("rejects invalid metric data as a whole before observations can be persisted", () => {
    for (const value of [-1, Infinity, {}, "1".repeat(513)]) expect(() => parseInstagramInsights(mutated(value), query, context)).toThrow();
    expect(() => parseInstagramInsights({ data: {} }, query, context)).toThrow();
    const copy = mutated(12); copy.data[0].period = "lifetime";
    expect(() => parseInstagramInsights(copy, query, context)).toThrow();
  });
});

it("reads the total-value shape only in an explicit validation mutation, retaining uncertain coverage", () => {
  // Validation mutation: add only the missing closing brace to Meta's exact example.
  const corrected = parseInsightJson(total.responseText + "}");
  const parsed = parseInstagramInsights(corrected, { ...query, grain: "range" }, { ...context, grain: "range", metricType: "total_value" });
  expect(parsed[0]).toMatchObject({ value: "224", windowStart: query.from, windowEnd: query.to, providerDay: null, boundaryBasis: "request_window_unconfirmed", coverageBasis: instagramCatalog[0].coverageBasis });
});

it("uses adjacent provider endpoints across an offset change without shifting their dates", () => {
  // Validation mutation, not a documented or recorded DST success.
  const copy = mutated("12");
  copy.data[0].values[0].end_time = "2026-03-08T00:00:00-0800";
  copy.data[0].values[1].end_time = "2026-03-09T00:00:00-0700";
  const parsed = parseInstagramInsights(copy, { ...query, from: "2026-03-07T08:00:00Z", to: "2026-03-09T07:00:00Z" }, context);
  expect(parsed[1]).toMatchObject({ windowStart: "2026-03-08T00:00:00-0800", windowEnd: "2026-03-09T00:00:00-0700", providerDay: "2026-03-08" });
  expect(Date.parse(parsed[1].windowEnd) - Date.parse(parsed[1].windowStart)).toBe(23 * 3600000);
});

it("keeps a missing provider day as a gap instead of a two-day observation", () => {
  // Validation mutation: remove the middle provider day from the example sequence.
  const copy = mutated("12");
  copy.data[0].values[1].end_time = "2018-01-13T08:00:00+0000";
  const parsed = parseInstagramInsights(copy, { ...query, to: "2018-01-13T08:00:00Z" }, context);
  expect(parsed[1]).toMatchObject({ windowStart: "2018-01-12T08:00:00+0000", providerDay: "2018-01-12", boundaryBasis: "provider_end_time_first_start_unconfirmed" });
});
it("rejects invalid dates and oversized series shapes", () => {
  const copy = mutated("12");
  copy.data[0].values[0].end_time = "2018-02-31T08:00:00+0000";
  expect(() => parseInstagramInsights(copy, query, context)).toThrow();
  copy.data[0].values = Array(101).fill({ value: "12", end_time: "2018-01-11T08:00:00+0000" });
  expect(() => parseInstagramInsights(copy, query, context)).toThrow();
});
