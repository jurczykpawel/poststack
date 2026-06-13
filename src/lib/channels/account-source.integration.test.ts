import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let svc: typeof import("./account-source");
let MetaTokenError: typeof import("@/lib/platforms/meta-token").MetaTokenError;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "dddddddd-0000-0000-0000-0000000000d1";
const realFetch = globalThis.fetch;

// A master token's Graph responses, parameterized so tests can vary the enumerated accounts.
function mockGraph(opts: {
  debug?: Record<string, unknown>;
  me?: Record<string, unknown>;
  fbPages?: unknown[];
  igPages?: unknown[];
} = {}) {
  const debug = opts.debug ?? { app_id: "111", is_valid: true, type: "USER", expires_at: 0, data_access_expires_at: 0 };
  const me = opts.me ?? { id: "MASTER1", name: "Master Account" };
  const fbPages = opts.fbPages ?? [{ id: "FB1", name: "Page One", access_token: "PT1", picture: { data: { url: "u1" } } }];
  const igPages = opts.igPages ?? [
    { id: "FB1", name: "Page One", access_token: "PT1", instagram_business_account: { id: "IG1", name: "IG One", username: "ig_one", profile_picture_url: "p" } },
  ];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/debug_token")) return Response.json({ data: debug });
    if (url.includes("/me/accounts") && url.includes("instagram_business_account")) return Response.json({ data: igPages });
    if (url.includes("/me/accounts")) return Response.json({ data: fbPages });
    if (url.includes("/me?")) return Response.json(me);
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "111";
  process.env.META_APP_SECRET = "sec";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  svc = await import("./account-source");
  ({ MetaTokenError } = await import("@/lib/platforms/meta-token"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "AS", slug: `as-${WS}` });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

async function channelsFor(): Promise<Array<{ platform: string; platform_id: string; source_id: string | null; connection_mode: string }>> {
  return db.query.channels.findMany({
    where: eq(s.channels.workspace_id, WS),
    columns: { platform: true, platform_id: true, source_id: true, connection_mode: true },
  });
}

describe("connectAccountSource (real Postgres)", () => {
  it("stores a system_user master and mints derived FB + IG channels linked to it", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const r = await svc.connectAccountSource(WS, "MASTER_TOKEN");

    expect(r.kind).toBe("system_user");
    expect(r.byPlatform).toEqual({ facebook: 1, instagram: 1 });

    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.workspace_id, WS) });
    expect(source?.provider_account_id).toBe("MASTER1");
    expect(source?.kind).toBe("system_user");
    expect(source?.data_access_expires_at).toBeNull(); // system_user → no 90d wall
    expect(source?.last_synced_at).not.toBeNull();
    expect((source?.metadata as { scopes?: string[] }).scopes).toEqual([]);

    const chans = await channelsFor();
    expect(chans).toHaveLength(2);
    for (const c of chans) {
      expect(c.connection_mode).toBe("derived");
      expect(c.source_id).toBe(source?.id);
    }
    expect(chans.map((c) => c.platform).sort()).toEqual(["facebook", "instagram"]);
  });

  it("records the 90-day data-access wall for a long-lived USER master", async () => {
    if (!TEST_DB) return;
    const wall = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    mockGraph({ debug: { app_id: "111", is_valid: true, type: "USER", expires_at: wall, data_access_expires_at: wall, scopes: ["pages_show_list", "instagram_basic"] } });
    const r = await svc.connectAccountSource(WS, "USER_TOKEN");

    expect(r.kind).toBe("user");
    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.workspace_id, WS) });
    expect(source?.data_access_expires_at).not.toBeNull();
    // the wall propagates to the derived channels for the badge/cron
    const chans = await db.query.channels.findMany({ where: eq(s.channels.workspace_id, WS), columns: { data_access_expires_at: true } });
    for (const c of chans) expect(c.data_access_expires_at).not.toBeNull();
  });

  it("rejects a PAGE token (managed connection needs a user/system-user token)", async () => {
    if (!TEST_DB) return;
    mockGraph({ debug: { app_id: "111", is_valid: true, type: "PAGE", profile_id: "FB1" } });
    await expect(svc.connectAccountSource(WS, "PAGE_TOKEN")).rejects.toBeInstanceOf(MetaTokenError);
    expect(await channelsFor()).toHaveLength(0);
  });

  it("is idempotent: re-connecting the same master updates the one source, no duplicate channels", async () => {
    if (!TEST_DB) return;
    mockGraph();
    await svc.connectAccountSource(WS, "MASTER_TOKEN");
    await svc.connectAccountSource(WS, "MASTER_TOKEN");

    const sources = await db.query.accountSources.findMany({ where: eq(s.accountSources.workspace_id, WS) });
    expect(sources).toHaveLength(1);
    expect(await channelsFor()).toHaveLength(2);
  });
});

describe("syncAccountSource (real Postgres)", () => {
  it("re-enumerates and mints a newly-added page on the next sync", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");
    expect(await channelsFor()).toHaveLength(2);

    // A second FB page appears under the same master.
    mockGraph({
      fbPages: [
        { id: "FB1", name: "Page One", access_token: "PT1" },
        { id: "FB2", name: "Page Two", access_token: "PT2" },
      ],
    });
    const r = await svc.syncAccountSource(sourceId);
    expect(r.byPlatform.facebook).toBe(2);

    const fb = (await channelsFor()).filter((c) => c.platform === "facebook").map((c) => c.platform_id).sort();
    expect(fb).toEqual(["FB1", "FB2"]);
  });

  it("bumps last_synced_at and clears prior error on a successful sync", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");
    await db.update(s.accountSources).set({ last_error: "old failure", last_synced_at: null }).where(eq(s.accountSources.id, sourceId));

    await svc.syncAccountSource(sourceId);
    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, sourceId) });
    expect(source?.last_error).toBeNull();
    expect(source?.last_synced_at).not.toBeNull();
  });

  it("no-ops on a disabled source", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");
    await db.update(s.accountSources).set({ status: "disabled" }).where(eq(s.accountSources.id, sourceId));
    const r = await svc.syncAccountSource(sourceId);
    expect(r.connected).toBe(0);
  });
});

describe("markSourceNeedsReauth — cascade + one-click reconnect recovery", () => {
  it("cascades needs_reauth to active derived children", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");

    await svc.markSourceNeedsReauth(sourceId, "token revoked");

    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, sourceId) });
    expect(source?.status).toBe("needs_reauth");
    const chans = await db.query.channels.findMany({ where: eq(s.channels.source_id, sourceId), columns: { status: true } });
    expect(chans).toHaveLength(2);
    for (const c of chans) expect(c.status).toBe("needs_reauth");
  });

  it("reconnecting the master recovers the source AND all children in one shot", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");
    await svc.markSourceNeedsReauth(sourceId, "token revoked");

    // Operator pastes a fresh token for the same account → one reconnect.
    mockGraph();
    await svc.connectAccountSource(WS, "FRESH_TOKEN");

    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, sourceId) });
    expect(source?.status).toBe("active");
    expect(source?.needs_reauth_reason).toBeNull();
    const chans = await db.query.channels.findMany({ where: eq(s.channels.source_id, sourceId), columns: { status: true } });
    for (const c of chans) expect(c.status).toBe("active");
  });
});

describe("sweepAccountSources (real Postgres)", () => {
  it("syncs healthy sources and marks a source whose master went invalid as needs_reauth", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const { sourceId } = await svc.connectAccountSource(WS, "MASTER_TOKEN");

    // Master token is now revoked → debug_token reports invalid → sync throws → sweep flags it.
    mockGraph({ debug: { app_id: "111", is_valid: false } });
    const r = await svc.sweepAccountSources();
    expect(r.failed).toBe(1);

    const source = await db.query.accountSources.findFirst({ where: eq(s.accountSources.id, sourceId) });
    expect(source?.status).toBe("needs_reauth");
    expect(source?.needs_reauth_reason).toBeTruthy();
  });
});
