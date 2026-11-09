import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { InsightMetric, InsightObservation, InsightsConnector } from "@/lib/insights/types";

// A second platform's connector proves the screen is generic: its catalog drives cards and labels.
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

const WS = randomUUID(), OTHER_WS = randomUUID(), BARE_WS = randomUUID(), USER = randomUUID(), BARE_USER = randomUUID();
const IG = randomUUID(), YT = randomUUID(), TG = randomUUID(), FOREIGN = randomUUID(), BARE_TG = randomUUID();
const LA = "America/Los_Angeles";
const DAY = 86400000;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: ReturnType<typeof import("@/server/app").buildApp>;
let service: typeof import("@/lib/insights/service");
let gate: typeof import("@/lib/license/gate");
let licenseInstance: typeof import("@/lib/license/__fixtures__/license-instance").licenseInstance;
let cookie: string, bareCookie: string;
let revision: string;
let fetchSpy: ReturnType<typeof vi.fn>;

/** Provider calendar day `offset` days from today in `zone`, as YYYY-MM-DD. */
function day(offset: number, zone = LA): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
}
/** Instant at which a provider day starts in `zone`. */
function dayStart(d: string, zone = LA): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const midnight = Date.parse(`${d}T00:00:00Z`);
  return new Date(midnight - offset(midnight - offset(midnight))).toISOString();
}

function observation(d: string, value: string, overrides: Partial<InsightObservation> = {}, zone = LA): InsightObservation {
  const next = new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
  return {
    platform: "instagram", metricKey: "reach", level: "account", subjectKey: "ig-account", grain: "day", period: "day", metricType: "time_series",
    windowStart: dayStart(d, zone), windowEnd: dayStart(next, zone), snapshotDay: d, providerDay: d, fetchedAt: new Date(Date.now() - 3600000).toISOString(),
    boundaryBasis: "provider_end_time", value, state: "available", dimensions: {}, queryParams: {}, transport: "facebook", apiVersion: "v26.0",
    definitionVersion: "instagram-reach-v1", coverageBasis: "provider_end_time", ...overrides,
  };
}

const usage = { percent: null, regainAfterSeconds: null };
const page = async (path: string, headers: Record<string, string> = {}, who = cookie) => {
  const res = await app.request(path, { headers: { cookie: who, ...headers } });
  return { status: res.status, text: await res.text(), headers: res.headers };
};
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form).toString() });
const graphCalls = () => fetchSpy.mock.calls.filter(([url]) => /graph\.(facebook|instagram)\.com/.test(String(url)));
const connection = (channelId: string, set: Partial<typeof import("@/db/schema").insightConnections.$inferInsert>) =>
  db.update(s.insightConnections).set(set).where(and(eq(s.insightConnections.workspace_id, WS), eq(s.insightConnections.channel_id, channelId)));

async function connect(channelId: string, transport: string, rev: string) {
  await service.setCollectionMode({ workspaceId: WS, channelId }, "on");
  await connection(channelId, { transport, credential_revision: rev });
}

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: "insights-ui-test-secret-at-least-32-chars",
    ENCRYPTION_KEY: "insights-ui-encryption-at-least-32-chars", CRON_SECRET: "insights-ui-cron-secret-at-least-32-chars", APP_URL: "http://localhost:3000",
  });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  service = await import("@/lib/insights/service");
  gate = await import("@/lib/license/gate");
  ({ licenseInstance } = await import("@/lib/license/__fixtures__/license-instance"));
  const { encryptTokens } = await import("@/lib/crypto");
  const { signSession } = await import("@/lib/auth");
  revision = (await import("@/lib/insights/credentials")).insightCredentialRevision("facebook", "test-user-token");
  cookie = `session=${await signSession(USER, WS)}`;
  bareCookie = `session=${await signSession(BARE_USER, BARE_WS)}`;
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.workspaces).values([{ id: WS, name: "Insights UI", slug: WS }, { id: OTHER_WS, name: "Other", slug: OTHER_WS }, { id: BARE_WS, name: "Bare", slug: BARE_WS }]);
  await db.insert(s.users).values([{ id: USER, email: `${USER}@example.com`, password_hash: "unused" }, { id: BARE_USER, email: `${BARE_USER}@example.com`, password_hash: "unused" }]);
  await db.insert(s.workspaceMembers).values([{ workspace_id: WS, user_id: USER, role: "owner" }, { workspace_id: BARE_WS, user_id: BARE_USER, role: "owner" }]);
  await db.insert(s.brands).values([{ workspace_id: WS, key: "alpha", name: "Alpha" }, { workspace_id: WS, key: "beta", name: "Beta" }]);
  const tokens = encryptTokens({ access_token: "test-page-token", user_access_token: "test-user-token" });
  // One insert shares created_at; IG is made older so "first channel" does not depend on random ids.
  await db.insert(s.channels).values([
    { id: IG, workspace_id: WS, platform: "instagram", platform_id: "ig-account", display_name: "IG Account", brand_key: "alpha", token_encrypted: tokens, webhook_secret: "unused", created_at: new Date(Date.now() - 60000) },
    { id: YT, workspace_id: WS, platform: "youtube", platform_id: "yt-account", display_name: "Video Account", brand_key: "beta", token_encrypted: tokens, webhook_secret: "unused" },
    { id: TG, workspace_id: WS, platform: "telegram", platform_id: "tg-account", display_name: "Chat Account", token_encrypted: tokens, webhook_secret: "unused" },
    { id: FOREIGN, workspace_id: OTHER_WS, platform: "instagram", platform_id: "foreign-account", display_name: "Foreign Account", token_encrypted: tokens, webhook_secret: "unused" },
    { id: BARE_TG, workspace_id: BARE_WS, platform: "telegram", platform_id: "bare-tg", display_name: "Bare Chat", token_encrypted: tokens, webhook_secret: "unused" },
  ]);
  await licenseInstance("pro");
});
beforeEach(async () => {
  for (const table of [s.insightObservations, s.insightConnections]) await db.delete(table).where(eq(table.workspace_id, WS));
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`);
  await db.update(s.channels).set({ status: "active" }).where(eq(s.channels.workspace_id, WS));
  fetchSpy = vi.fn(async () => new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.clearAllMocks();
  if (!(await gate.hasFeature("insights"))) await licenseInstance("pro");
});
afterAll(async () => {
  await db.execute(sql`select graphile_worker.remove_job(key) from graphile_worker._private_jobs where payload->>'workspaceId' = ${WS}`);
  for (const id of [WS, OTHER_WS, BARE_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  for (const id of [USER, BARE_USER]) await db.delete(s.users).where(eq(s.users.id, id));
});

describe("insights page selection and URL state", () => {
  it("lists channels with the capability on any platform and selects the first by default", async () => {
    const { status, text } = await page("/insights");
    expect(status).toBe(200);
    expect(text).toContain(`value="${IG}"`);
    expect(text).toContain(`value="${YT}"`);
    expect(text).not.toContain(`value="${TG}"`);
    expect(text).toMatch(new RegExp(`<option value="${IG}" selected`));
    expect(graphCalls()).toEqual([]);
  });

  it("does not replace a channel from another workspace with the first one", async () => {
    const { status, text } = await page(`/insights?channel=${FOREIGN}`);
    expect(status).toBe(200);
    expect(text).toContain("This channel is not available");
    expect(text).not.toContain("Foreign Account");
    expect(text).not.toMatch(/<option value="[^"]+" selected/);
    expect(text).not.toContain("ins-card");
  });

  it("filters the channel list by brand without summing accounts", async () => {
    const { text } = await page("/insights?brand=beta");
    expect(text).not.toContain(`value="${IG}"`);
    expect(text).toMatch(new RegExp(`<option value="${YT}" selected`));
  });

  it("keeps brand, channel, range and metric in links, forms and htmx history", async () => {
    await connect(YT, "test", "test-revision");
    await connection(YT, { access_state: "ready", reason: "none" });
    const full = await page(`/insights?brand=beta&channel=${YT}&range=30&metric=watch_time`);
    expect(full.text).toContain("<html");
    expect(full.text).toContain('hx-push-url="true"');
    expect(full.text).toMatch(/name="range" value="30"[^>]*aria-pressed="true"/);
    expect(full.text).toMatch(/name="range" value="7"[^>]*aria-pressed="false"/);
    expect(full.text).toMatch(/name="metric" value="watch_time"[^>]*aria-pressed="true"/);
    expect(full.text).toContain('<input type="hidden" name="brand" value="beta"');
    const fragment = await page(`/insights?brand=beta&channel=${YT}&range=30&metric=watch_time`, { "HX-Request": "true" });
    expect(fragment.text).not.toContain("<html");
    expect(fragment.text).toContain('id="insights-root"');
    expect(fragment.text).toMatch(/name="range" value="30"[^>]*aria-pressed="true"/);
    const restore = await page(`/insights?channel=${YT}&range=30`, { "HX-Request": "true", "HX-History-Restore-Request": "true" });
    expect(restore.text).toContain("<html");
  });
});

describe("insights cards and chart", () => {
  it("renders another platform's catalog, including a stored true zero, without Instagram copy", async () => {
    await connect(YT, "test", "test-revision");
    await service.storeInsightBatch({ workspaceId: WS, channelId: YT }, "test-revision", { usage, observations: [-7, -6, -5, -4, -3, -2, -1].map((offset) =>
      observation(day(offset, "UTC"), "0", { platform: "youtube", metricKey: "watch_time", subjectKey: "yt-account", transport: "test", apiVersion: "test-v1", definitionVersion: "test-watch-time-v1" }, "UTC")) });
    const { text } = await page(`/insights?brand=beta&channel=${YT}`);
    expect(text).toContain("Watch time");
    expect(text).toMatch(/class="ins-card-v">0 ms</);
    expect(text).not.toContain("Reach");
    expect(text).not.toContain("Instagram");
    expect(text).not.toContain("NaN");
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it("never shows a summed reach total; daily values stay in the chart and table", async () => {
    await connect(IG, "facebook", revision);
    await service.storeInsightBatch({ workspaceId: WS, channelId: IG }, revision, { usage, observations: [observation(day(-5), "5"), observation(day(-4), "7")] });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toMatch(/class="ins-card-v">—</);
    expect(text).toContain("Total not available for unique metrics");
    expect(text).not.toMatch(/class="ins-card-v">12</);
    expect(text).toMatch(new RegExp(`<th scope="row">${day(-5)}[^<]*</th><td>5</td>`));
    expect(text).toMatch(new RegExp(`<th scope="row">${day(-4)}[^<]*</th><td>7</td>`));
    expect(text).toContain("Some days have no data yet");
    // Inactive catalog entries are named, never rendered as cards with an invented zero.
    expect(text).toContain("Not collected for this channel yet");
    expect(text.match(/class="ins-card[ "]/g)).toHaveLength(1);
    expect(graphCalls()).toEqual([]);
  });
});

describe("insights states", () => {
  it("offers to turn collection on, naming only account metrics", async () => {
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Turn on Insights for IG Account");
    expect(text).toContain('action="/insights/collection"');
    expect(text).not.toContain('action="/insights/consent"');
    expect(text).not.toMatch(/demograph|audience|posts statistics/i);
  });

  it("shows first sync while access is checked", async () => {
    await service.setCollectionMode({ workspaceId: WS, channelId: IG }, "on");
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Collecting the first data");
  });

  it("asks for additional access with a consent action when a permission is missing or was declined", async () => {
    await connect(IG, "facebook", revision);
    await connection(IG, { access_state: "missing_permission", reason: "permission_required" });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Insights needs additional access");
    expect(text).toContain('action="/insights/consent"');
    expect(text).toContain("Publishing and Inbox keep working");
    expect(text).toContain("data you already collected stays");
  });

  it("asks to sign in again when the Insights login is no longer valid", async () => {
    await connect(IG, "facebook", revision);
    await connection(IG, { access_state: "needs_reauth", reason: "token_required" });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Sign in again to keep collecting");
    expect(text).toContain('action="/insights/consent"');
  });

  it("explains an account type without statistics", async () => {
    await connect(IG, "facebook", revision);
    await connection(IG, { access_state: "unsupported", reason: "permission_required" });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("does not provide account statistics");
  });

  it("explains a paused channel", async () => {
    await connect(IG, "facebook", revision);
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, IG));
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Channel is paused");
    expect(text).toContain(`href="/channels/${IG}"`);
  });

  it("keeps the last data with the next attempt while the platform limits requests", async () => {
    await connect(IG, "facebook", revision);
    await service.storeInsightBatch({ workspaceId: WS, channelId: IG }, revision, { usage, observations: [observation(day(-3), "9")] });
    const next = new Date(Date.now() + 3600000);
    await connection(IG, { backoff_until: next, reason: "rate_limited" });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("temporarily limiting requests");
    expect(text).toContain(`datetime="${next.toISOString()}"`);
    expect(text).toMatch(new RegExp(`<th scope="row">${day(-3)}[^<]*</th><td>9</td>`));
  });

  it("flags a delayed worker after 48 hours without a successful sync", async () => {
    await connect(IG, "facebook", revision);
    await service.storeInsightBatch({ workspaceId: WS, channelId: IG }, revision, { usage, observations: [observation(day(-5), "4", { fetchedAt: new Date(Date.now() - 3 * DAY).toISOString() })] });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Collection looks delayed");
    expect(text).toContain("worker");
  });

  it("flags a first sync without progress for more than 15 minutes", async () => {
    await service.setCollectionMode({ workspaceId: WS, channelId: IG }, "on");
    await connection(IG, { last_attempt_at: new Date(Date.now() - 20 * 60000) });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("Collection looks delayed");
  });

  it("shows an empty period for a connected channel without data in range", async () => {
    await connect(IG, "facebook", revision);
    await service.storeInsightBatch({ workspaceId: WS, channelId: IG }, revision, { usage, observations: [observation(day(-60), "4")] });
    const { text } = await page(`/insights?channel=${IG}`);
    expect(text).toContain("No data for this period yet");
  });

  it("points a workspace without a supported channel to Channels", async () => {
    const { text } = await page("/insights", {}, bareCookie);
    expect(text).toContain("Connect a channel that provides Insights");
    expect(text).toContain('href="/channels"');
    expect(text).not.toContain(`value="${BARE_TG}"`);
  });

  it("locks the page on FREE without inviting consent", async () => {
    await gate.clearLicense();
    const { status, text } = await page(`/insights?channel=${IG}`);
    expect(status).toBe(200);
    expect(text).toMatch(/<h1>Insights <span class="badge">PRO<\/span><\/h1>/);
    expect(text).toContain("Upgrade to PRO");
    expect(text).not.toContain("/insights/consent");
    expect(text).not.toContain("/insights/collection");
  });
});

describe("insights mutations", () => {
  it("turns collection on through the shared API handler, for htmx and plain forms", async () => {
    const htmx = await post("/insights/collection", { channel: IG, mode: "on", range: "7" }, { "HX-Request": "true" });
    expect(htmx.status).toBe(200);
    expect(await htmx.text()).toContain("Collecting the first data");
    expect((await service.getInsightStatus({ workspaceId: WS, channelId: IG })).collectionMode).toBe("on");
    const plain = await post("/insights/collection", { channel: IG, mode: "off" });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe(`/insights?channel=${IG}&range=7`);
    expect((await service.getInsightStatus({ workspaceId: WS, channelId: IG })).collectionMode).toBe("off");
  });

  it("refresh queues once, polls the local status, then reports the next allowed time", async () => {
    await connect(IG, "facebook", revision);
    await connection(IG, { access_state: "ready", reason: "none" });
    const first = await post("/insights/refresh", { channel: IG }, { "HX-Request": "true" });
    expect(first.status).toBe(200);
    const queued = await first.text();
    expect(queued).toContain("hx-get=\"/insights/status?");
    expect(queued).toContain('hx-trigger="load delay:5s"');
    const second = await post("/insights/refresh", { channel: IG }, { "HX-Request": "true" });
    expect(second.status).toBe(200);
    const later = await second.text();
    expect(later).toContain("Next refresh available");
    expect(later).toMatch(/datetime="\d{4}-\d{2}-\d{2}T/);
    expect(graphCalls()).toEqual([]);
  });

  it("stops polling after 12 attempts with a lasting message", async () => {
    await connect(IG, "facebook", revision);
    const polling = await page(`/insights/status?channel=${IG}&n=3&since=`);
    expect(polling.text).toContain("n=4");
    expect(polling.text).toContain('hx-trigger="load delay:5s"');
    const done = await page(`/insights/status?channel=${IG}&n=12&since=`);
    expect(done.text).not.toContain("hx-trigger");
    expect(done.text).toContain("Still collecting");
  });

  it("shows the Insights status and link on the channel detail page", async () => {
    await connect(IG, "facebook", revision);
    await connection(IG, { access_state: "missing_permission", reason: "permission_required" });
    const { text } = await page(`/channels/${IG}`);
    expect(text).toContain("Additional access required");
    expect(text).toContain(`href="/insights?channel=${IG}"`);
    expect(text).toContain('action="/insights/consent"');
    const telegram = await page(`/channels/${TG}`);
    expect(telegram.text).not.toContain("ins-channel-panel");
  });
});
