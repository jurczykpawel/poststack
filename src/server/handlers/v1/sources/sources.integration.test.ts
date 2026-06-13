import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let cookie: string;

const WS = "a7a7a7a7-0000-0000-0000-0000000000a1";
const USER = "a7a7a7a7-0000-0000-0000-0000000000a2";
const realFetch = globalThis.fetch;

function mockGraph(opts: { fbPages?: unknown[] } = {}) {
  const fbPages = opts.fbPages ?? [{ id: "FB1", name: "Page One", access_token: "PT1" }];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/debug_token")) return Response.json({ data: { app_id: "111", is_valid: true, type: "USER", expires_at: 0, data_access_expires_at: 0 } });
    if (url.includes("/me/accounts") && url.includes("instagram_business_account"))
      return Response.json({ data: [{ id: "FB1", name: "Page One", access_token: "PT1", instagram_business_account: { id: "IG1", name: "IG One", username: "ig_one", profile_picture_url: "p" } }] });
    if (url.includes("/me/accounts")) return Response.json({ data: fbPages });
    if (url.includes("/me?")) return Response.json({ id: "MASTER1", name: "Master Acct" });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "111";
  process.env.META_APP_SECRET = "sec";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  app = (await import("@/server/app")).buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  gate = await import("@/lib/license/gate");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  mockGraph();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "SRC", slug: `src-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  if (closeQueue) await closeQueue();
});

const connect = (token = "MASTER_TOKEN_aaaaaaaaaaaa") =>
  app.request("/api/v1/sources", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ token }) });

describe("/api/v1/sources — managed_connection PRO gate", () => {
  it("blocks connecting without a PRO license (402)", async () => {
    if (!TEST_DB) return;
    const res = await connect();
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("PRO_REQUIRED");
  });

  it("blocks listing without a PRO license (402)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/sources", { headers: { cookie } });
    expect(res.status).toBe(402);
  });

  it("blocks sync + delete without a PRO license (402) — consistent with GET/POST", async () => {
    if (!TEST_DB) return;
    const id = "a7a7a7a7-0000-0000-0000-0000000000fe";
    const sync = await app.request(`/api/v1/sources/${id}/sync`, { method: "POST", headers: { cookie } });
    expect(sync.status).toBe(402);
    const del = await app.request(`/api/v1/sources/${id}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(402);
  });
});

describe("/api/v1/sources — connect + list + sync + delete (PRO, real Postgres)", () => {
  beforeEach(async () => {
    if (!TEST_DB) return;
    await licenseInstance("pro");
  });

  it("connects a master token and lists the source with its derived channels", async () => {
    if (!TEST_DB) return;
    const res = await connect();
    expect(res.status).toBe(201);
    const created = (await res.json()).data;
    expect(created.by_platform).toEqual({ facebook: 1, instagram: 1 });

    const list = await app.request("/api/v1/sources", { headers: { cookie } });
    expect(list.status).toBe(200);
    const sources = (await list.json()).data;
    expect(sources).toHaveLength(1);
    expect(sources[0].provider_account_id).toBe("MASTER1");
    expect(sources[0].channels).toHaveLength(2);
    expect(sources[0].channels.map((c: { platform: string }) => c.platform).sort()).toEqual(["facebook", "instagram"]);
  });

  it("syncs a source (re-enumerate) and 404s an unknown id", async () => {
    if (!TEST_DB) return;
    const sourceId = (await (await connect()).json()).data.source_id;

    mockGraph({ fbPages: [{ id: "FB1", name: "Page One", access_token: "PT1" }, { id: "FB2", name: "Page Two", access_token: "PT2" }] });
    const sync = await app.request(`/api/v1/sources/${sourceId}/sync`, { method: "POST", headers: { cookie } });
    expect(sync.status).toBe(200);
    expect((await sync.json()).data.by_platform.facebook).toBe(2);

    const miss = await app.request(`/api/v1/sources/a7a7a7a7-0000-0000-0000-0000000000ff/sync`, { method: "POST", headers: { cookie } });
    expect(miss.status).toBe(404);
  });

  it("deletes a source (204) and the derived channels survive as standalone", async () => {
    if (!TEST_DB) return;
    const sourceId = (await (await connect()).json()).data.source_id;

    const del = await app.request(`/api/v1/sources/${sourceId}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(204);

    const sources = await db.query.accountSources.findMany({ where: eq(s.accountSources.workspace_id, WS) });
    expect(sources).toHaveLength(0);
    const chans = await db.query.channels.findMany({ where: eq(s.channels.workspace_id, WS), columns: { source_id: true } });
    expect(chans).toHaveLength(2);
    for (const c of chans) expect(c.source_id).toBeNull(); // FK set null kept the channels
  });
});
