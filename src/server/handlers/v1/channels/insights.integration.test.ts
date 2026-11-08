import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { InsightMetric, InsightObservation, InsightsConnector } from "@/lib/insights/types";

// A second platform's connector proves the handlers stay generic: no platform branch in routing.
const fake = vi.hoisted(() => {
  const catalog: InsightMetric[] = [{
    key: "watch_time", label: "Watch time", level: "account", unit: "milliseconds", period: "day", grain: "day",
    aggregation: "sum", additive: true, definitionVersion: "test-watch-time-v1", coverageBasis: "provider_end_time", cardOrder: 1, chartable: true,
  }];
  return { catalog, access: vi.fn(), fetch: vi.fn(), consentTransport: vi.fn(async () => null) };
});
vi.mock("@/lib/insights/catalog", async (original) => {
  const actual = await original<typeof import("@/lib/insights/catalog")>();
  const connector: InsightsConnector = { source: "test_video", catalog: () => fake.catalog, access: fake.access, fetch: fake.fetch, consentTransport: fake.consentTransport };
  return { ...actual, getInsightsConnector: (platform: Parameters<typeof actual.getInsightsConnector>[0]) => platform === "youtube" ? connector : actual.getInsightsConnector(platform) };
});

const WS = randomUUID(), OTHER_WS = randomUUID(), USER = randomUUID();
const IG = randomUUID(), YT = randomUUID(), TG = randomUUID(), FOREIGN = randomUUID();
const READ = "sk_live_insights_read_key", WRITE = "sk_live_insights_write_key", NONE = "sk_live_insights_none_key";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: ReturnType<typeof import("@/server/app").buildApp>;
let service: typeof import("@/lib/insights/service");
let licenseInstance: typeof import("@/lib/license/__fixtures__/license-instance").licenseInstance;
let cookie: string;
let revision: string;
let fetchSpy: ReturnType<typeof vi.fn>;

const base = (id: string) => `/api/v1/channels/${id}/insights`;
const bearer = (key: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${key}`, ...extra });
const get = (path: string, key = READ) => app.request(path, { headers: bearer(key) });
const patch = (id: string, body: unknown, headers: Record<string, string> = bearer(WRITE)) =>
  app.request(base(id), { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const refresh = (id: string, headers: Record<string, string> = bearer(WRITE)) => app.request(`${base(id)}/refresh`, { method: "POST", headers });
const graphCalls = () => fetchSpy.mock.calls.filter(([url]) => /graph\.(facebook|instagram)\.com/.test(String(url)));
const jobs = async () => (await db.execute(sql`select payload from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`)).rows;

function observation(overrides: Partial<InsightObservation>): InsightObservation {
  return {
    platform: "instagram", metricKey: "reach", level: "account", subjectKey: "ig-account", grain: "day", period: "day", metricType: "time_series",
    windowStart: "2026-10-03T07:00:00Z", windowEnd: "2026-10-04T07:00:00Z", snapshotDay: "2026-10-03", providerDay: "2026-10-03",
    fetchedAt: "2026-10-06T00:00:00Z", boundaryBasis: "provider_end_time", value: "0", state: "available", dimensions: {}, queryParams: {},
    transport: "facebook", apiVersion: "v26.0", definitionVersion: "instagram-reach-v1", coverageBasis: "provider_end_time", ...overrides,
  };
}

async function seed() {
  for (const table of [s.insightObservations, s.insightConnections]) await db.delete(table).where(eq(table.workspace_id, WS));
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`);
  for (const [channelId, transport, rev] of [[IG, "facebook", revision], [YT, "test", "test-revision"]] as const) {
    const ref = { workspaceId: WS, channelId };
    await service.setCollectionMode(ref, "on");
    await db.update(s.insightConnections).set({ transport, credential_revision: rev })
      .where(and(eq(s.insightConnections.workspace_id, WS), eq(s.insightConnections.channel_id, channelId)));
  }
  const usage = { percent: null, regainAfterSeconds: null };
  await service.storeInsightBatch({ workspaceId: WS, channelId: IG }, revision, { usage, observations: [
    observation({}),
    observation({ grain: "range", metricType: "total_value", windowEnd: "2026-10-05T07:00:00Z", providerDay: null }),
  ] });
  await service.storeInsightBatch({ workspaceId: WS, channelId: YT }, "test-revision", { usage, observations: [observation({
    platform: "youtube", metricKey: "watch_time", subjectKey: "yt-account", windowStart: "2026-10-03T00:00:00Z", windowEnd: "2026-10-04T00:00:00Z",
    transport: "test", apiVersion: "test-v1", definitionVersion: "test-watch-time-v1",
  })] });
}

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: "insights-api-test-secret-at-least-32-chars",
    ENCRYPTION_KEY: "insights-api-encryption-at-least-32-chars", CRON_SECRET: "insights-api-cron-secret-at-least-32-chars", APP_URL: "http://localhost:3000",
  });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  service = await import("@/lib/insights/service");
  ({ licenseInstance } = await import("@/lib/license/__fixtures__/license-instance"));
  const { encryptTokens } = await import("@/lib/crypto");
  const { signSession } = await import("@/lib/auth");
  revision = (await import("@/lib/insights/credentials")).insightCredentialRevision("facebook", "test-user-token");
  cookie = `session=${await signSession(USER, WS)}`;
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.workspaces).values([{ id: WS, name: "Insights", slug: WS }, { id: OTHER_WS, name: "Other", slug: OTHER_WS }]);
  await db.insert(s.users).values({ id: USER, email: `${USER}@example.com`, password_hash: "unused" });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.apiKeys).values(([[READ, ["stats:read"]], [WRITE, ["channels:write"]], [NONE, ["contacts:read"]]] as const).map(([key, scopes]) => ({
    workspace_id: WS, name: key, key_prefix: key.slice(0, 10), key_hash: createHash("sha256").update(key).digest("hex"), scopes: [...scopes],
  })));
  const tokens = encryptTokens({ access_token: "test-page-token", user_access_token: "test-user-token" });
  await db.insert(s.channels).values([
    { id: IG, workspace_id: WS, platform: "instagram", platform_id: "ig-account", token_encrypted: tokens, webhook_secret: "unused" },
    { id: YT, workspace_id: WS, platform: "youtube", platform_id: "yt-account", token_encrypted: tokens, webhook_secret: "unused" },
    { id: TG, workspace_id: WS, platform: "telegram", platform_id: "tg-account", token_encrypted: tokens, webhook_secret: "unused" },
    { id: FOREIGN, workspace_id: OTHER_WS, platform: "instagram", platform_id: "foreign-account", token_encrypted: tokens, webhook_secret: "unused" },
  ]);
  await licenseInstance("pro");
});
beforeEach(async () => {
  await seed();
  fetchSpy = vi.fn(async () => new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
afterAll(async () => {
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`);
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

describe("insights REST status and account report", () => {
  it("returns local status with envelope, CORS and meta, without provider requests", async () => {
    for (const headers of [bearer(READ), { cookie }]) {
      const res = await app.request(base(IG), { headers: { ...headers, origin: "https://client.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const json = await res.json();
      expect(json.error).toBeNull();
      expect(json.data).toMatchObject({ channelId: IG, platform: "instagram", collectionMode: "on", displayStatus: "connected", state: "ready" });
      expect(json.meta).toMatchObject({ source: "meta_instagram", transport: "facebook", nextRetryAt: null });
      expect(json.meta.lastSuccessfulSyncAt).toBe("2026-10-06T00:00:00.000Z");
    }
    expect(graphCalls()).toEqual([]);
  });

  it("returns a stored zero as the decimal string and keeps provider days", async () => {
    const res = await get(`${base(IG)}/account?from=2026-10-03&to=2026-10-05`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.error).toBeNull();
    expect(json.data.summary[0]).toMatchObject({ metricKey: "reach", value: "0", complete: true });
    expect(json.data.series).toHaveLength(1);
    expect(json.data.series[0]).toMatchObject({ value: "0", providerDay: "2026-10-03", windowStart: "2026-10-03T07:00:00.000Z" });
    expect(json.data.catalog.map((m: InsightMetric) => m.key)).toContain("reach");
    expect(json.meta).toMatchObject({ source: "meta_instagram", transport: "facebook", apiVersion: "v26.0",
      coverage: { from: "2026-10-03", toExclusive: "2026-10-05", complete: true, boundaryBasis: "provider_end_time" } });
    expect(graphCalls()).toEqual([]);
  });

  it("returns 200 with an empty series for an Instagram range without data", async () => {
    const res = await get(`${base(IG)}/account?from=2026-09-01&to=2026-09-08&metrics=reach`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.series).toEqual([]);
    expect(json.data.summary[0]).toMatchObject({ metricKey: "reach", value: null, complete: false });
    expect(json.meta.apiVersion).toBeNull();
  });

  it("serves a different platform's catalog through the same handlers", async () => {
    const status = await (await get(base(YT))).json();
    expect(status.data).toMatchObject({ platform: "youtube", source: "test_video" });
    const json = await (await get(`${base(YT)}/account?from=2026-10-03&to=2026-10-04`)).json();
    expect(json.data.summary).toEqual([expect.objectContaining({ metricKey: "watch_time", value: "0", complete: true })]);
    expect(json.data.catalog.map((m: InsightMetric) => m.key)).toEqual(["watch_time"]);
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(fake.access).not.toHaveBeenCalled();
  });

  it("never serializes credentials, ciphertext or budget keys", async () => {
    await db.update(s.insightConnections).set({ budget_key: "meta-user:private-budget" }).where(eq(s.insightConnections.workspace_id, WS));
    const [channel] = await db.select({ token: s.channels.token_encrypted }).from(s.channels).where(eq(s.channels.id, IG));
    for (const path of [base(IG), `${base(IG)}/account?from=2026-10-03&to=2026-10-05`]) {
      const text = await (await get(path)).text();
      for (const secret of ["test-user-token", "test-page-token", channel.token, "private-budget", "budgetKey", "budget_key"]) expect(text).not.toContain(secret);
    }
  });
});

describe("insights REST boundaries", () => {
  it("requires authentication before any data", async () => {
    for (const res of [await app.request(base(IG)), await app.request(`${base(IG)}/account?from=2026-10-03&to=2026-10-05`),
      await patch(IG, { collectionMode: "off" }, {}), await refresh(IG, {})]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ data: null, error: { code: "unauthorized" } });
    }
  });

  it("requires stats:read to read and channels:write to change", async () => {
    for (const res of [await get(base(IG), WRITE), await get(`${base(IG)}/account?from=2026-10-03&to=2026-10-05`, NONE),
      await patch(IG, { collectionMode: "off" }, bearer(READ)), await refresh(IG, bearer(READ))]) {
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("insufficient_scope");
    }
  });

  it("returns 404 for another workspace, unknown or malformed channels, before capability and license", async () => {
    const { clearLicense } = await import("@/lib/license/gate");
    await clearLicense();
    try {
      for (const id of [FOREIGN, randomUUID(), "not-a-uuid"]) {
        for (const res of [await get(base(id)), await get(`${base(id)}/account?from=2026-10-03&to=2026-10-05`), await patch(id, { collectionMode: "on" }), await refresh(id)]) {
          expect(res.status).toBe(404);
          expect((await res.json()).error.code).toBe("not_found");
        }
      }
      expect((await get(base(TG))).status).toBe(422);
      const locked = await get(base(IG));
      expect(locked.status).toBe(402);
      expect((await locked.json()).error).toMatchObject({ code: "pro_required", details: { feature: "insights" } });
      for (const res of [await get(`${base(IG)}/account?from=2026-10-03&to=2026-10-05`), await patch(IG, { collectionMode: "on" }), await refresh(IG)]) expect(res.status).toBe(402);
    } finally {
      await licenseInstance("pro");
    }
    expect(graphCalls()).toEqual([]);
  });

  it("returns 422 for a known channel without the insights capability", async () => {
    for (const res of [await get(base(TG)), await get(`${base(TG)}/account?from=2026-10-03&to=2026-10-05`), await patch(TG, { collectionMode: "on" }), await refresh(TG)]) {
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("insights_unsupported");
    }
  });

  it.each([
    ["unknown metric", "from=2026-10-03&to=2026-10-05&metrics=impressions"],
    ["duplicate metric", "from=2026-10-03&to=2026-10-05&metrics=reach,reach"],
    ["empty metric", "from=2026-10-03&to=2026-10-05&metrics="],
    ["more than 16 metrics", `from=2026-10-03&to=2026-10-05&metrics=${Array.from({ length: 17 }, (_, i) => `m${i}`).join(",")}`],
    ["metric longer than 128", `from=2026-10-03&to=2026-10-05&metrics=${"m".repeat(129)}`],
    ["more than 90 days", "from=2026-01-01&to=2026-04-02"],
    ["empty range", "from=2026-10-03&to=2026-10-03"],
    ["reversed range", "from=2026-10-05&to=2026-10-03"],
    ["impossible date", "from=2026-02-30&to=2026-03-02"],
    ["non-leap 29 February", "from=2025-02-29&to=2025-03-02"],
    ["timestamp with zone", "from=2026-10-03T00:00:00Z&to=2026-10-05"],
    ["offset timestamp", "from=2026-10-03T00:00:00%2B02:00&to=2026-10-05T00:00:00-07:00"],
    ["missing from", "to=2026-10-05"],
    ["repeated parameter", "from=2026-10-03&from=2026-10-04&to=2026-10-05"],
    ["unknown parameter", "from=2026-10-03&to=2026-10-05&grain=day"],
    ["query longer than 2048", `from=2026-10-03&to=2026-10-05&metrics=reach&pad=${"x".repeat(2048)}`],
  ])("rejects %s with 400", async (_name, query) => {
    const res = await get(`${base(IG)}/account?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ data: null, error: { code: "bad_request" } });
  });

  it("accepts leap day and exactly 90 days", async () => {
    expect((await get(`${base(IG)}/account?from=2024-02-29&to=2024-03-01`)).status).toBe(200);
    expect((await get(`${base(IG)}/account?from=2026-01-01&to=2026-04-01`)).status).toBe(200);
  });
});

describe("insights REST mutations", () => {
  it("switches collection on with an access check job and a dashboard hint, without OAuth or provider requests", async () => {
    await service.setCollectionMode({ workspaceId: WS, channelId: IG }, "off");
    const res = await patch(IG, { collectionMode: "on" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ channelId: IG, collectionMode: "on", displayStatus: "checking" });
    expect(json.meta.hint).toMatch(/dashboard/i);
    expect(JSON.stringify(json)).not.toMatch(/oauth|https?:\/\//i);
    expect((await jobs()).map((j) => j.payload)).toEqual([expect.objectContaining({ workspaceId: WS, channelId: IG })]);
    expect(graphCalls()).toEqual([]);
    expect(fake.consentTransport).not.toHaveBeenCalled();
  });

  it("switches collection off without a job and keeps stored observations", async () => {
    const res = await patch(IG, { collectionMode: "off" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ collectionMode: "off", displayStatus: "off" });
    expect(await jobs()).toEqual([]);
    const rows = await db.select().from(s.insightObservations).where(and(eq(s.insightObservations.workspace_id, WS), eq(s.insightObservations.channel_id, IG)));
    expect(rows).toHaveLength(2);
  });

  it.each([
    ["unknown mode", { collectionMode: "maybe" }],
    ["unknown field", { collectionMode: "on", transport: "facebook" }],
    ["missing mode", {}],
    ["array body", [{ collectionMode: "on" }]],
    ["malformed JSON", "{"],
  ])("rejects a body with %s as 422", async (_name, body) => {
    const res = await patch(IG, body);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("validation_error");
  });

  it("refuses cross-site dashboard writes but accepts API keys from other origins", async () => {
    const crossSite = { cookie, "sec-fetch-site": "cross-site" };
    expect((await patch(IG, { collectionMode: "off" }, crossSite)).status).toBe(403);
    expect((await refresh(IG, crossSite)).status).toBe(403);
    expect((await patch(IG, { collectionMode: "off" }, { cookie, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await patch(IG, { collectionMode: "on" }, bearer(WRITE, { origin: "https://client.example" }))).status).toBe(200);
  });

  it("accepts one of two concurrent refreshes and rate-limits the other with retry_after", async () => {
    const responses = await Promise.all([refresh(IG), refresh(IG)]);
    expect(responses.map((r) => r.status).sort()).toEqual([202, 429]);
    const accepted = await responses.find((r) => r.status === 202)!.json();
    expect(accepted.data).toMatchObject({ queued: true, status: { channelId: IG, collectionMode: "on" } });
    const limited = responses.find((r) => r.status === 429)!;
    const retryAfter = Number(limited.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
    expect(await limited.json()).toMatchObject({ data: null, error: { code: "rate_limited", details: { retry_after: retryAfter } } });
    expect(await jobs()).toHaveLength(1);
    expect(graphCalls()).toEqual([]);
  });

  it("rate-limits a refresh during provider backoff without resetting it", async () => {
    const until = new Date(Date.now() + 3600000);
    await db.update(s.insightConnections).set({ backoff_until: until }).where(and(eq(s.insightConnections.workspace_id, WS), eq(s.insightConnections.channel_id, IG)));
    const res = await refresh(IG);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3500);
    const [row] = await db.select().from(s.insightConnections).where(and(eq(s.insightConnections.workspace_id, WS), eq(s.insightConnections.channel_id, IG)));
    expect(row.backoff_until?.getTime()).toBe(until.getTime());
  });

  it("returns 202 without a job while collection is off", async () => {
    await service.setCollectionMode({ workspaceId: WS, channelId: IG }, "off");
    const res = await refresh(IG);
    expect(res.status).toBe(202);
    expect((await res.json()).data).toMatchObject({ queued: false, status: { collectionMode: "off" } });
    expect(await jobs()).toEqual([]);
  });
});
