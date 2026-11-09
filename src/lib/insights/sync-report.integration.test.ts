import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

// End-to-end consumer check: the real worker fetches a multi-day history from a stubbed Graph API
// (documented reach response shape, dates moved to the current window), stores it, and both
// readers (REST and the dashboard loader) must return every stored provider day.
const LA = "America/Los_Angeles";
const DAY = 86400000;
const WS = randomUUID(), CH = randomUUID();
const KEY = "sk_live_insights_cohort_key";
const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/instagram/account-series.json", import.meta.url), "utf8"));
const documented = (JSON.parse(fixture.responseText).data as { name: string }[]).find((m) => m.name === "reach")!;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: ReturnType<typeof import("@/server/app").buildApp>;

/** Instant at which a provider day starts in Los Angeles. */
function dayStart(d: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: LA, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const midnight = Date.parse(`${d}T00:00:00Z`);
  return midnight - offset(midnight - offset(midnight));
}
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: LA, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const graphTime = (t: number) => new Date(t).toISOString().slice(0, 19) + "+0000";

/**
 * Stub of the Graph API insights endpoint: one documented `reach` entry whose `values` hold every
 * daily end_time (Los Angeles midnight) inside the inclusive since/until range of the request.
 */
function graphResponse(url: URL, currentDay = today()): Response {
  const since = Number(url.searchParams.get("since")) * 1000, until = Number(url.searchParams.get("until")) * 1000;
  const values: { value: number; end_time: string }[] = [];
  for (let d = shift(currentDay, -120); d <= shift(currentDay, 1); d = shift(d, 1)) {
    const end = dayStart(shift(d, 1));
    if (end >= since && end <= until) values.push({ value: Number(d.slice(8)) + 100, end_time: graphTime(end) });
  }
  return new Response(JSON.stringify({ data: [{ ...documented, values }] }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: "insights-cohort-test-secret-at-least-32-chars",
    ENCRYPTION_KEY: "insights-cohort-encryption-at-least-32-chars", CRON_SECRET: "insights-cohort-cron-secret-at-least-32-chars", APP_URL: "http://localhost:3000",
  });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  const { encryptTokens } = await import("@/lib/crypto");
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.workspaces).values({ id: WS, name: "Cohort", slug: WS });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: KEY, key_prefix: KEY.slice(0, 10), key_hash: createHash("sha256").update(KEY).digest("hex"), scopes: ["stats:read"] });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "ig-account", webhook_secret: "unused",
    token_encrypted: encryptTokens({ access_token: "test-page-token", user_access_token: "test-user-token" }) });
  await (await import("@/lib/license/__fixtures__/license-instance")).licenseInstance("pro");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.facebook.com") return new Response("unexpected", { status: 503 });
    return graphResponse(url);
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

it("returns every provider day the worker stored from multi-day and single-day fetches", async () => {
  const ref = { workspaceId: WS, channelId: CH };
  await (await import("./service")).setCollectionMode(ref, "on");
  await (await import("./sync")).processInsightsSync(ref);

  const from = shift(today(), -30), to = today();
  const stored = await db.select({ day: s.insightObservations.provider_day, basis: s.insightObservations.boundary_basis })
    .from(s.insightObservations).where(and(eq(s.insightObservations.workspace_id, WS), eq(s.insightObservations.response_state, "available")));
  const inRange = stored.filter((r) => r.day! >= from && r.day! < to);
  const expected = [...new Set(inRange.map((r) => r.day!))].sort();
  // The scenario must mix first-of-batch and follow-on points, otherwise it proves nothing.
  expect(new Set(inRange.map((r) => /unconfirmed/.test(r.basis))).size).toBe(2);
  expect(expected.length).toBeGreaterThan(14);

  const res = await app.request(`/api/v1/channels/${CH}/insights/account?from=${from}&to=${to}&metrics=reach`, { headers: { authorization: `Bearer ${KEY}` } });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.series.map((o: { providerDay: string }) => o.providerDay)).toEqual(expected);
  for (const o of json.data.series) expect(o.value).toBe(String(Number(o.providerDay.slice(8)) + 100));
  // A day is partial only when no stored point for it has a provider-confirmed start.
  const confirmed = new Set(inRange.filter((r) => !/unconfirmed/.test(r.basis)).map((r) => r.day));
  expect(json.data.series.filter((o: { partial: boolean }) => o.partial).map((o: { providerDay: string }) => o.providerDay))
    .toEqual(expected.filter((d) => !confirmed.has(d)));

  const { loadInsightsPage } = await import("@/server/ui/sections/insights-data");
  const page = await loadInsightsPage(WS, new URLSearchParams({ channel: CH, range: "30" }));
  expect(page.report?.series.map((o) => o.providerDay)).toEqual(expected);
});

it("stores every provider day through yesterday across the November DST change", async () => {
  const ref = { workspaceId: WS, channelId: CH };
  const schedule = await import("./schedule");
  const original = schedule.collectionQueries;
  const now = new Date("2026-11-09T12:00:00Z");
  const windows: import("./types").InsightQuery[][] = [];
  // Pin the collection calendar, keeping leases and PG's now() on the real clock.
  const calendar = vi.spyOn(schedule, "collectionQueries").mockImplementation((_, ...args) => {
    const queries = original(now, ...args);
    windows.push(queries);
    return queries;
  });
  const fetcher = vi.fn(async (input: string | URL) => graphResponse(new URL(String(input)), "2026-11-09"));
  vi.stubGlobal("fetch", fetcher);
  try {
    await db.delete(s.insightObservations).where(eq(s.insightObservations.workspace_id, WS));
    await db.delete(s.insightConnections).where(eq(s.insightConnections.workspace_id, WS));
    await (await import("./service")).setCollectionMode(ref, "on");
    const { processInsightsSync } = await import("./sync");
    const storedDays = async () => {
      const rows = await db.select({ day: s.insightObservations.provider_day }).from(s.insightObservations)
        .where(and(eq(s.insightObservations.workspace_id, WS), eq(s.insightObservations.channel_id, CH), eq(s.insightObservations.metric_key, "reach"), eq(s.insightObservations.response_state, "available")));
      return [...new Set(rows.map(r => r.day!))].sort();
    };
    const expected = (from: string) => {
      const days: string[] = [];
      for (let day = from; day < "2026-11-09"; day = shift(day, 1)) days.push(day);
      return days;
    };
    await processInsightsSync(ref);
    expect(fetcher).toHaveBeenCalledTimes(10);
    const firstStart = windows[0].at(-1)!.from.slice(0, 10);
    expect((await storedDays()).filter(day => day >= firstStart)).toEqual(expected(firstStart));
    for (let run = 0; run < 2; run++) {
      await db.update(s.insightConnections).set({ next_due_at: new Date(0) })
        .where(and(eq(s.insightConnections.workspace_id, WS), eq(s.insightConnections.channel_id, CH)));
      await processInsightsSync(ref);
    }
    expect((await storedDays()).filter(day => day >= "2026-08-11")).toEqual(expected("2026-08-11"));
    const points = await db.select({ day: s.insightObservations.provider_day, end: s.insightObservations.window_end })
      .from(s.insightObservations).where(and(eq(s.insightObservations.workspace_id, WS), eq(s.insightObservations.metric_key, "reach")));
    expect(points.some(p => p.day === "2026-10-31" && p.end.toISOString() === "2026-11-01T07:00:00.000Z")).toBe(true);
    expect(points.some(p => p.day === "2026-11-01" && p.end.toISOString() === "2026-11-02T08:00:00.000Z")).toBe(true);
  } finally {
    calendar.mockRestore();
  }
});
