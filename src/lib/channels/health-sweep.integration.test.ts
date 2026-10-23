import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let sweep: typeof import("./health-sweep");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "bbbbbbbb-0000-0000-0000-0000000000b1";
const realFetch = globalThis.fetch;

// debug_token verdict keyed by the token string the mock sees.
const verdicts: Record<string, { is_valid: boolean; scopes?: string[] }> = {};

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "111";
  process.env.META_APP_SECRET = "sec";
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL; // health sweep alert path is exercised elsewhere
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  sweep = await import("./health-sweep");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const k of Object.keys(verdicts)) delete verdicts[k];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const m = /input_token=([^&]+)/.exec(url);
    const token = m ? decodeURIComponent(m[1]) : "";
    const v = verdicts[token];
    if (v) return Response.json({ data: { app_id: "111", is_valid: v.is_valid, scopes: v.scopes } });
    return new Response("Not Found", { status: 404 }); // → inspectMetaToken returns null (transient)
  }) as typeof fetch;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "HS", slug: `hs-${WS}` });
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

async function channel(platform: "facebook" | "instagram" | "telegram", token: string, status: "active" | "needs_reauth" = "active") {
  const [row] = await db
    .insert(s.channels)
    .values({
      workspace_id: WS,
      platform,
      platform_id: `pid-${token}`,
      display_name: `ch-${token}`,
      token_encrypted: encryptTokens({ access_token: token }),
      webhook_secret: "sec",
      status,
    })
    .returning({ id: s.channels.id });
  return row.id;
}

async function statusOf(id: string) {
  const c = await db.query.channels.findFirst({ where: eq(s.channels.id, id), columns: { status: true } });
  return c?.status;
}

describe("sweepChannelHealth (real Postgres)", () => {
  it("trips needs_reauth on a confirmed-bad token, leaves a valid one active", async () => {
    if (!TEST_DB) return;
    verdicts["BAD"] = { is_valid: false };
    verdicts["GOOD"] = { is_valid: true };
    const bad = await channel("facebook", "BAD");
    const good = await channel("instagram", "GOOD");

    const r = await sweep.sweepChannelHealth();
    expect(r.flagged).toBe(1);
    expect(await statusOf(bad)).toBe("needs_reauth");
    expect(await statusOf(good)).toBe("active");
  });

  it("leaves a channel active when the check is inconclusive (transient/404)", async () => {
    if (!TEST_DB) return;
    const ch = await channel("facebook", "UNKNOWN"); // no verdict → 404 → null inspection
    const r = await sweep.sweepChannelHealth();
    expect(r.flagged).toBe(0);
    expect(await statusOf(ch)).toBe("active");
  });

  it("skips non-Meta channels (no debug_token)", async () => {
    if (!TEST_DB) return;
    verdicts["TG"] = { is_valid: false };
    const tg = await channel("telegram", "TG");
    const r = await sweep.sweepChannelHealth();
    expect(r.checked).toBe(0);
    expect(r.flagged).toBe(0);
    expect(await statusOf(tg)).toBe("active");
  });

  it("self-heals a needs_reauth channel when debug_token re-confirms the token is valid", async () => {
    if (!TEST_DB) return;
    verdicts["FLAP"] = { is_valid: true }; // a healthy token that was latched by a transient blip
    const ch = await channel("facebook", "FLAP", "needs_reauth");
    const r = await sweep.sweepChannelHealth();
    expect(r.recovered).toBe(1);
    expect(await statusOf(ch)).toBe("active");
  });

  it("leaves a needs_reauth channel down when the token is still confirmed bad (no re-alert)", async () => {
    if (!TEST_DB) return;
    verdicts["DEAD"] = { is_valid: false };
    const ch = await channel("instagram", "DEAD", "needs_reauth");
    const r = await sweep.sweepChannelHealth();
    expect(r.recovered).toBe(0);
    expect(r.flagged).toBe(0); // already needs_reauth — not counted/re-flagged
    expect(await statusOf(ch)).toBe("needs_reauth");
  });

  it("does NOT recover a needs_reauth channel on an inconclusive (transient/404) check", async () => {
    if (!TEST_DB) return;
    const ch = await channel("facebook", "NOVERDICT", "needs_reauth"); // 404 → null inspection
    const r = await sweep.sweepChannelHealth();
    expect(r.recovered).toBe(0);
    expect(await statusOf(ch)).toBe("needs_reauth");
  });
});

it("records checked scopes during the sweep and preserves other metadata", async () => {
  verdicts["SCOPES"] = { is_valid: true, scopes: ["pages_messaging"] };
  const id = await channel("facebook", "SCOPES");
  await db.update(s.channels).set({ metadata: { retained: "yes" } }).where(eq(s.channels.id, id));
  await sweep.sweepChannelHealth();
  const row = await db.query.channels.findFirst({ where: eq(s.channels.id, id) });
  expect(row?.metadata).toMatchObject({ retained: "yes", granted_scopes: ["pages_messaging"], granted_scopes_checked_at: expect.any(String) });
  expect(row?.status).toBe("active");
});

it("merges scope records and leaves unknown results unchanged within the workspace", async () => {
  const { recordGrantedScopes } = await import("./granted-scopes");
  const id = await channel("facebook", "RECORD");
  await db.update(s.channels).set({ metadata: { retained: "yes" } }).where(eq(s.channels.id, id));
  await recordGrantedScopes(id, ["pages_manage_posts"], WS);
  const read = () => db.query.channels.findFirst({ where: eq(s.channels.id, id) });
  const recorded = (await read())?.metadata;
  expect(recorded).toMatchObject({ retained: "yes", granted_scopes: ["pages_manage_posts"], granted_scopes_checked_at: expect.any(String) });
  await recordGrantedScopes(id, [], WS);
  await recordGrantedScopes(id, null, WS);
  await recordGrantedScopes(id, ["other"], "bbbbbbbb-0000-0000-0000-0000000000b2");
  expect((await read())?.metadata).toEqual(recorded);
});

it.each(["oauth", "manual_token", "derived"] as const)("records scopes on %s connect and reconnect through the shared upsert", async (connectionMode) => {
  const { upsertChannels } = await import("./upsert");
  verdicts["CONNECT"] = { is_valid: true, scopes: ["pages_messaging"] };
  const accounts = [{ platformId: "scope-connect", displayName: "Page", tokens: { access_token: "CONNECT" } }];
  await upsertChannels(WS, "facebook", accounts, { connectionMode });
  const read = () => db.query.channels.findFirst({ where: eq(s.channels.platform_id, "scope-connect") });
  expect((await read())?.metadata).toMatchObject({ granted_scopes: ["pages_messaging"] });
  verdicts["CONNECT"].scopes = ["pages_messaging", "pages_manage_posts"];
  await upsertChannels(WS, "facebook", accounts, { connectionMode });
  expect((await read())?.metadata).toMatchObject({ granted_scopes: ["pages_messaging", "pages_manage_posts"] });
  verdicts["CONNECT"] = { is_valid: false };
  await expect(upsertChannels(WS, "facebook", accounts, { connectionMode })).resolves.toBeDefined();
  delete verdicts["CONNECT"];
  await expect(upsertChannels(WS, "facebook", accounts, { connectionMode })).resolves.toBeDefined();
  expect((await read())?.metadata).toMatchObject({ granted_scopes: ["pages_messaging", "pages_manage_posts"] });
});

it("keeps scope records for the current token only", async () => {
  const { recordGrantedScopes } = await import("./granted-scopes");
  const id = await channel("facebook", "CURRENT");
  await recordGrantedScopes(id, ["pages_messaging"], WS, encryptTokens({ access_token: "OLD" }));
  expect((await db.query.channels.findFirst({ where: eq(s.channels.id, id) }))?.metadata).toEqual({});
});

it("skips inspection for an Instagram Login only channel", async () => {
  await channel("instagram", "");
  await sweep.sweepChannelHealth();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("records scopes during a manual health check", async () => {
  const { runHealthCheck } = await import("./service");
  verdicts["ONDEMAND"] = { is_valid: true, scopes: ["pages_manage_posts"] };
  const id = await channel("facebook", "ONDEMAND");
  expect(await runHealthCheck(WS, id)).toBe("active");
  expect((await db.query.channels.findFirst({ where: eq(s.channels.id, id) }))?.metadata).toMatchObject({ granted_scopes: ["pages_manage_posts"] });
});
