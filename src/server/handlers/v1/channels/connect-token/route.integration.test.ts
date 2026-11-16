import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import docs from "../../../../../../tests/fixtures/provider-docs/tiktok.json";

const { hasFeature } = vi.hoisted(() => ({ hasFeature: vi.fn(async () => true) }));
vi.mock("@/lib/license/gate", async original => ({ ...await original<typeof import("@/lib/license/gate")>(), hasFeature }));
const WS = randomUUID(), KEY = "sk_live_tiktok_manual_integration", WRONG = "sk_live_tiktok_wrong_scope";
const input = { platform: "tiktok", access_token: "pasted-access", refresh_token: "pasted-refresh", client_key: "issuer-key", client_secret: "issuer-secret" };
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let crypto: typeof import("@/lib/crypto");
let app: ReturnType<typeof import("@/server/app").buildApp>;
let http: ReturnType<typeof vi.fn>;
const logInfo = vi.fn();
const helpers = { logger: { info: logInfo } } as unknown as JobHelpers;
const read = () => db.query.channels.findFirst({ where: eq(s.channels.workspace_id, WS) });
const connect = (body: unknown = input, key = KEY) => app.request("/api/v1/channels/connect-token", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: "tiktok-test-jwt-secret-at-least-32-chars", ENCRYPTION_KEY: "tiktok-test-encryption-at-least-32-chars", CRON_SECRET: "tiktok-test-cron-secret-at-least-32-chars", APP_URL: "http://localhost:3000" });
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema"); crypto = await import("@/lib/crypto");
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.workspaces).values({ id: WS, name: "TikTok", slug: WS });
  await db.insert(s.apiKeys).values([KEY, WRONG].map(key => ({ workspace_id: WS, name: "test", key_hash: createHash("sha256").update(key).digest("hex"), key_prefix: key.slice(0, 12), scopes: key === KEY ? ["channels:write", "channels:read"] : ["channels:read"] })));
});
beforeEach(async () => {
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  vi.clearAllMocks(); hasFeature.mockResolvedValue(true);
  http = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/oauth/token/")) return Response.json(docs.refresh.ok);
    if (url.includes("/user/info/")) return Response.json(docs.userInfo.ok.body);
    throw new Error(`Unexpected HTTP request: ${init?.method}`);
  });
  vi.stubGlobal("fetch", http);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await db.delete(s.workspaces).where(eq(s.workspaces.id, WS)); await (await import("@/lib/queue/client")).closeQueue(); });

it("connects, scans and rotates the issuing app token through the worker", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const res = await connect();
  expect(res.status).toBe(201); expect(await res.json()).toEqual({ data: { connected: 1 }, error: null });
  const ch = (await read())!;
  expect(ch).toMatchObject({ platform: "tiktok", platform_id: docs.userInfo.ok.body.data.user.open_id, connection_mode: "manual_token", status: "active" });
  const secret = { issuerClientKey: input.client_key, issuerClientSecret: input.client_secret };
  expect(crypto.decryptTokens(ch.token_encrypted)).toMatchObject(secret);
  expect(ch.token_encrypted).not.toContain(input.client_secret);
  expect(ch.metadata).not.toHaveProperty("issuerClientSecret");
  const list = await app.request("/api/v1/channels", { headers: { authorization: `Bearer ${KEY}` } });
  const output = await list.text();
  for (const value of Object.values(input).filter(v => v !== "tiktok")) expect(output).not.toContain(value);
  await db.update(s.channels).set({ token_expires_at: new Date(Date.now() + 1800_000) }).where(eq(s.channels.id, ch.id));
  const { scanExpiringTokens } = await import("@/lib/workers/token-refresh-scan");
  await scanExpiringTokens();
  const { sql } = await import("drizzle-orm");
  const jobs = await db.execute(sql`SELECT payload FROM graphile_worker._private_jobs WHERE key = ${`token-refresh-${ch.id}`}`);
  expect(jobs.rows).toEqual([expect.objectContaining({ payload: { channelId: ch.id } })]);
  http.mockImplementation(async () => Response.json({ ...docs.refresh.ok, access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 7200 }));
  const { processTokenRefresh } = await import("@/lib/workers/token-refresh-worker");
  await processTokenRefresh({ channelId: ch.id }, helpers);
  expect(new URLSearchParams(String(http.mock.calls.at(-1)![1].body)).get("client_secret")).toBe(input.client_secret);
  const updated = (await read())!;
  expect(crypto.decryptTokens(updated.token_encrypted)).toMatchObject({ ...secret, access_token: "rotated-access", refresh_token: "rotated-refresh" });
  expect(updated.token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 7100_000);
  expect(JSON.stringify([log.mock.calls, logInfo.mock.calls])).not.toContain(input.client_secret);
  const audits = await db.query.auditLogs.findMany({ where: eq(s.auditLogs.workspace_id, WS) });
  expect(JSON.stringify(audits)).not.toContain(input.client_secret);
});
it("recovers an expired pasted access token", async () => {
  http.mockImplementation(async (url: string, init?: RequestInit) => url.includes("/oauth/token/") ? Response.json(docs.refresh.ok) : new Headers(init?.headers).get("authorization") === `Bearer ${input.access_token}` ? Response.json(docs.userInfo.tokenInvalid.body, { status: 401 }) : Response.json(docs.userInfo.ok.body));
  expect((await connect()).status).toBe(201);
  expect((await read())!.token_expires_at).not.toBeNull();
});
it("rejects rejected credentials with a fixed response and no channel", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  http.mockImplementation(async () => Response.json({ error: input.client_secret, error_description: input.refresh_token }, { status: 401 }));
  const res = await connect(); expect(res.status).toBe(400);
  expect(await res.text()).not.toContain(input.client_secret);
  expect(JSON.stringify(log.mock.calls)).not.toContain(input.client_secret);
  expect(await read()).toBeUndefined();
});
it("uses the existing license gate", async () => {
  hasFeature.mockResolvedValue(false);
  expect((await connect()).status).toBe(402);
  expect(hasFeature).toHaveBeenCalledWith("non_meta_channels");
  expect(await read()).toBeUndefined();
});
it.each(["access_token", "refresh_token", "client_key", "client_secret"])("requires %s", async field => {
  const res = await connect({ ...input, [field]: "" }); expect(res.status).toBe(422); expect(http).not.toHaveBeenCalled();
});
it("requires channels:write before contacting TikTok", async () => {
  expect((await connect(input, WRONG)).status).toBe(403); expect(http).not.toHaveBeenCalled();
});
