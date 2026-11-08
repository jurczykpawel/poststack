import { afterEach, describe, expect, it, vi } from "vitest";
import series from "@/lib/insights/__fixtures__/instagram/account-series.json";
import { instagramCatalog } from "@/lib/insights/instagram/catalog";
import { parseInsightJson } from "@/lib/insights/instagram/json";
import { parseInstagramInsights } from "@/lib/insights/instagram/parser";
import { buildAccountReport, type InsightStatus } from "@/lib/insights/service";
import type { InsightObservation, InsightQuery } from "@/lib/insights/types";
import { insightsChart } from "./insights-chart";

vi.hoisted(() => { Object.assign(process.env, { DATABASE_URL: "postgres://test:test@localhost:5432/unused", ENCRYPTION_KEY: "chart-test-encryption-key-at-least-32-chars", JWT_SECRET: "chart-test-secret-at-least-32-characters", CRON_SECRET: "chart-test-cron-at-least-32-characters", APP_URL: "http://localhost:3000" }); });

const status: InsightStatus = {
  channelId: "00000000-0000-4000-8000-000000000001", platform: "instagram", source: "meta_instagram", collectionMode: "on", displayStatus: "connected",
  state: "ready", transport: "facebook", credentialRevision: "rev", requiredPermissions: [], missingPermissions: [], checkedAt: null,
  lastAttemptAt: null, lastSuccessfulSyncAt: "2018-01-14T00:00:00.000Z", nextRetryAt: null, reason: "none", stale: false,
};

/**
 * Stored observations derived from the official account example through the real parser. Mutations
 * change only end_time/value of the recorded reach entry so the model has a gap, a zero or a large value.
 */
function stored(points: Array<{ end: string; value: unknown }>): InsightObservation[] {
  // One recorded response per day, as the daily D-1..D-7 corrections store them.
  return points.flatMap((p) => {
    const copy = parseInsightJson(series.responseText) as { data: Array<{ name: string; values: unknown[] }> };
    copy.data = copy.data.filter((m) => m.name === "reach");
    copy.data[0].values = [{ value: p.value, end_time: `${p.end}T08:00:00+0000` }];
    const query: InsightQuery = { level: "account", subjectKey: "account", from: "2018-01-01T08:00:00Z", to: "2018-01-20T08:00:00Z", metrics: ["reach"], grain: "day" };
    return parseInstagramInsights(copy, query, {
      platform: "instagram", level: "account", subjectKey: "account", grain: "day", period: "day", metricType: "time_series",
      windowStart: query.from, windowEnd: query.to, snapshotDay: "2018-01-13", fetchedAt: "2018-01-13T09:00:00Z", providerDay: null,
      boundaryBasis: "provider_end_time", queryParams: {}, transport: "facebook", apiVersion: "v26.0",
      definitionVersion: instagramCatalog[0].definitionVersion, coverageBasis: "provider_end_time",
    });
  });
}

function report(points: Array<{ end: string; value: unknown }>, from = "2018-01-10", to = "2018-01-13") {
  const query: InsightQuery = { level: "account", subjectKey: "account", from: `${from}T08:00:00.000Z`, to: `${to}T08:00:00.000Z`, metrics: ["reach"], grain: "day" };
  return buildAccountReport(instagramCatalog, stored(points), query, status);
}

const render = (r: ReturnType<typeof report>) => String(insightsChart(r, "reach"));
const linePaths = (out: string) => out.match(/<path class="ins-line"/g) ?? [];
const axisY = (out: string) => Number(/<line class="ins-axis"[^>]*y1="([\d.]+)"/.exec(out)?.[1]);
const pointY = (out: string, day: string) => Number(new RegExp(`<circle[^>]*data-day="${day}"[^>]*cy="([\\d.]+)"`).exec(out)?.[1]);
const tableRow = (out: string, day: string) => new RegExp(`<tr><th scope="row">${day}[^<]*</th>(.*?)</tr>`).exec(out)?.[1] ?? "";

afterEach(() => vi.useRealTimers());

describe("insights chart", () => {
  it("splits the line at a missing day and keeps a zero on the axis", () => {
    vi.useFakeTimers({ now: new Date("2018-02-01T00:00:00Z") });
    const out = render(report([{ end: "2018-01-11", value: 12 }, { end: "2018-01-13", value: 0 }]));
    expect(out).not.toContain("NaN");
    expect(linePaths(out)).toHaveLength(2);
    expect(pointY(out, "2018-01-12")).toBe(axisY(out));
    expect(pointY(out, "2018-01-10")).toBeLessThan(axisY(out));
    expect(out).not.toMatch(/data-day="2018-01-11"/);
    expect(out).toContain('role="img"');
    expect(out).toMatch(/<title[^>]*>.*Reach/);
  });

  it("lists the same values by unchanged provider day in the accessible table", () => {
    vi.useFakeTimers({ now: new Date("2018-02-01T00:00:00Z") });
    const out = render(report([{ end: "2018-01-11", value: 12 }, { end: "2018-01-13", value: 0 }]));
    expect(out).toContain("<details");
    expect(tableRow(out, "2018-01-10")).toContain(">12<");
    expect(tableRow(out, "2018-01-11")).toContain(">—<");
    expect(tableRow(out, "2018-01-12")).toContain(">0<");
  });

  it("renders a single point, an all-zero and an all-null range without NaN", () => {
    vi.useFakeTimers({ now: new Date("2018-02-01T00:00:00Z") });
    const single = render(report([{ end: "2018-01-11", value: 5 }], "2018-01-10", "2018-01-11"));
    expect(single).not.toContain("NaN");
    expect(linePaths(single)).toHaveLength(1);
    const zeros = render(report([{ end: "2018-01-11", value: 0 }, { end: "2018-01-12", value: 0 }, { end: "2018-01-13", value: 0 }]));
    expect(zeros).not.toContain("NaN");
    for (const day of ["2018-01-10", "2018-01-11", "2018-01-12"]) expect(pointY(zeros, day)).toBe(axisY(zeros));
    const empty = render(report([]));
    expect(empty).not.toContain("NaN");
    expect(linePaths(empty)).toHaveLength(0);
    expect(empty).toContain("No data for this period");
  });

  it("dashes the provisional last 48 hours and labels them in the table", () => {
    vi.useFakeTimers({ now: new Date("2018-01-13T12:00:00Z") });
    const out = render(report([{ end: "2018-01-11", value: 12 }, { end: "2018-01-12", value: 14 }, { end: "2018-01-13", value: 9 }]));
    expect(out).toMatch(/<path class="ins-prov"/);
    expect(out).toMatch(/<th scope="row">2018-01-12 \(provisional\)<\/th>/);
    expect(out).toMatch(/<th scope="row">2018-01-10<\/th>/);
    expect(out).toContain("provisional");
  });

  it("shows large stored values exactly, without rounding", () => {
    vi.useFakeTimers({ now: new Date("2018-02-01T00:00:00Z") });
    const out = render(report([{ end: "2018-01-11", value: "9007199254740993" }], "2018-01-10", "2018-01-11"));
    expect(tableRow(out, "2018-01-10")).toContain(">9,007,199,254,740,993<");
    expect(out).not.toContain("NaN");
  });

  it("describes partial and stale data in the panel", () => {
    vi.useFakeTimers({ now: new Date("2018-02-01T00:00:00Z") });
    const out = render(report([{ end: "2018-01-11", value: 12 }, { end: "2018-01-13", value: 3 }]));
    expect(out).toContain("Some days have no data yet");
    expect(out).toContain("last collected data");
  });
});
