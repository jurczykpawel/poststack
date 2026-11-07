import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import chat from "./__fixtures__/openai-chat.json";
import models from "./__fixtures__/openai-models.json";
import claude from "./__fixtures__/anthropic-message.json";

const WS = randomUUID(), OTHER = randomUUID(), USER = randomUUID(), NONOP = randomUUID();
const KEY = "sk-provider-test-1234567890ABCDEFGH";
let app: Hono, db: typeof import("../db").db, s: typeof import("@/db/schema");
let store: typeof import("./provider-store"), server: Server, base: string;
let cookie: string, nonopCookie: string;
let seen: { model: string; path: string }[] = [];
const request = async (method: string, path = "", body?: unknown, auth?: string) => {
  const r = await app.request(`/api/v1/settings/ai/providers${path}`, { method, headers: { cookie: auth ?? cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  expect(text).not.toContain(KEY); expect(text).not.toContain("api_key_encrypted");
  return { status: r.status, body: JSON.parse(text) };
};
const add = async (model = "good") => request("POST", "", { provider: "custom", base_url: base, model, api_key: KEY });
const rows = async () => (await request("GET")).body.data;
beforeAll(async () => {
  Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: "test-secret-at-least-32-characters-long", ENCRYPTION_KEY: "provider-store-test-key-at-least-32-characters", CRON_SECRET: "provider-test-cron-at-least-32-characters", APP_URL: "http://localhost:3000" });
  ({ db } = await import("../db")); s = await import("@/db/schema");
  Object.assign((await import("../env")).env, { INSTANCE_ADMIN_EMAILS: `${USER}@example.test` });
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.users).values([USER, NONOP].map(id => ({ id, email: `${id}@example.test` })));
  await db.insert(s.workspaces).values([WS, OTHER].map(id => ({ id, name: "Provider test", slug: id })));
  await db.insert(s.workspaceMembers).values([USER, NONOP].map(id => ({ workspace_id: WS, user_id: id, role: "owner" as const })));
  const { signSession } = await import("../auth");
  cookie = `session=${await signSession(USER, WS)}`; nonopCookie = `session=${await signSession(NONOP, WS)}`;
  server = createServer((req, res) => {
    let raw = ""; req.on("data", b => { raw += b; }); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ model: body.model ?? "", path: req.url! }); res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/messages") ? req.headers["x-api-key"] !== KEY : req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; return res.end("{}"); }
      const status = /^http-(\d+)/.exec(body.model ?? "");
      if (status) { res.statusCode = Number(status[1]); return res.end(JSON.stringify({ error: { code: res.statusCode === 429 ? "insufficient_quota" : "invalid_request" } })); }
      if (body.model === "empty") return res.end(JSON.stringify({ choices: [] }));
      res.end(JSON.stringify(req.url?.endsWith("/models") ? models : req.url?.endsWith("/messages") ? claude : chat));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  process.env.AI_ALLOWED_PRIVATE_TARGETS = new URL(base).host;
  store = await import("./provider-store");
});
beforeEach(async () => {
  await db.delete(s.aiProviders); await db.delete(s.instanceSettings); await db.delete(s.rateLimitCounters);
  (await import("../settings/config")).invalidateConfigCache(); seen = [];
  for (const key of ["AI_API_KEY", "AI_PROVIDER", "AI_FALLBACKS", "AI_MODEL", "AI_BASE_URL"]) delete process.env[key];
});
afterAll(async () => {
  if (s?.aiProviders) { await db.delete(s.aiProviders); await db.delete(s.instanceSettings); }
  if (s) { await db.delete(s.workspaces).where(eq(s.workspaces.id, WS)); await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER)); await db.delete(s.users).where(eq(s.users.id, USER)); await db.delete(s.users).where(eq(s.users.id, NONOP)); }
  server?.close(); await db?.$client.end();
});
it("requires the instance operator and saves only tested encrypted keys", async () => {
  expect((await request("GET", "", undefined, "")).status).toBe(401);
  expect((await request("GET", "", undefined, nonopCookie)).status).toBe(403);
  expect((await add("http-401")).status).toBe(422); expect(await rows()).toEqual([]);
  expect((await add()).status).toBe(201);
  const [row] = await db.select().from(s.aiProviders).where(isNull(s.aiProviders.workspace_id));
  expect(row.api_key_encrypted).toMatch(/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/);
  expect((await import("../crypto")).decryptString(row.api_key_encrypted)).toBe(KEY);
  expect((await rows())[0]).toMatchObject({ position: 1, api_key_hint: "EFGH", answering_now: false });
});
it("keeps positions contiguous across concurrent additions and reordered removal", async () => {
  await Promise.all(Array.from({ length: 5 }, () => add()));
  const ids = (await rows()).map((r: { id: string }) => r.id);
  expect((await rows()).map((r: { position: number }) => r.position)).toEqual([1, 2, 3, 4, 5]);
  expect((await request("PUT", "/reorder", { ids: [ids[0], ids[0]] })).status).toBe(409);
  expect((await request("PUT", "/reorder", { ids: [...ids].reverse() })).status).toBe(200);
  expect((await rows()).map((r: { id: string }) => r.id)).toEqual([...ids].reverse());
  await request("DELETE", `/${ids[2]}`);
  expect((await rows()).map((r: { position: number }) => r.position)).toEqual([1, 2, 3, 4]);
});
it("uses only the instance list and requires a new key for a different target", async () => {
  const saved = (await add()).body.data;
  expect((await request("PATCH", `/${saved.id}`, { model: "good2" })).status).toBe(200);
  expect((await request("PATCH", `/${saved.id}`, { base_url: base + "/other" })).status).toBe(422);
  expect((await request("POST", "/models", { id: saved.id })).body.data.models.length).toBeGreaterThan(0);
  const { encryptString } = await import("../crypto");
  const [other] = await db.insert(s.aiProviders).values({ workspace_id: OTHER, position: 1, provider: "custom", base_url: base, model: "other", api_key_encrypted: encryptString(KEY), api_key_hint: "EFGH" }).returning();
  expect((await request("DELETE", `/${other.id}`)).status).toBe(404);
  expect((await rows()).length).toBe(1);
});
it("imports existing settings and backups once, preserving keys and order", async () => {
  const { setConfigs } = await import("../settings/config");
  await setConfigs([["AI_PROVIDER", "custom"], ["AI_API_KEY", KEY], ["AI_MODEL", "legacy"], ["AI_BASE_URL", base], ["AI_FALLBACKS", JSON.stringify([{ apiKey: KEY, model: "backup", baseUrl: base }])]]);
  await Promise.all([store.migrateInstanceProviders(), store.migrateInstanceProviders()]);
  const initial = await rows(); expect(initial.map((r: { model: string }) => r.model)).toEqual(["legacy", "backup"]);
  expect((await store.storedProviderChain())?.map(r => r.apiKey)).toEqual([KEY, KEY]);
  await request("DELETE", `/${initial[0].id}`); await store.migrateInstanceProviders();
  expect((await rows()).map((r: { model: string }) => r.model)).toEqual(["backup"]);
  expect((await db.select().from(s.instanceSettings)).map(r => r.key)).toEqual(["AI_PROVIDERS_MIGRATED"]);
});
it("replaces JSON atomically and keeps backup IDs when legacy settings edit Main", async () => {
  await add(); await add("backup"); const original = await rows();
  expect((await request("PUT", "", { providers: original.map((r: { id: string }, i: number) => ({ id: r.id, model: i ? "http-401" : "changed" })) })).status).toBe(422);
  expect(await rows()).toEqual(original);
  const response = await app.request("/api/v1/settings/ai", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ provider: "custom", base_url: base, model: "edited" }) });
  expect(response.status).toBe(200); expect((await rows())[1].id).toBe(original[1].id);
});
for (const status of [401, 404, 429, 500, 503, "empty"] as const) it(`uses the next provider after ${status}`, async () => {
  await add(); await add("backup"); const [main, backup] = await rows();
  await db.update(s.aiProviders).set({ model: status === "empty" ? "empty" : `http-${status}` }).where(eq(s.aiProviders.id, main.id));
  const { chatComplete } = await import("./client");
  seen = []; expect(await chatComplete({ workspaceId: WS, kind: "draft", system: "Help", user: "Hello" })).toBeTruthy();
  expect(seen.map(r => r.model)).toEqual([status === "empty" ? "empty" : `http-${status}`, "backup"]);
  expect((await rows()).find((r: { id: string }) => r.id === backup.id).answering_now).toBe(true);
  await request("POST", `/${main.id}/test`, {});
  expect((await rows()).find((r: { id: string }) => r.id === backup.id).answering_now).toBe(true);
});
for (const status of [400, 413, 422]) it(`stops after request status ${status}`, async () => {
  await add(); await add("backup"); const [main] = await rows();
  await db.update(s.aiProviders).set({ model: `http-${status}` }).where(eq(s.aiProviders.id, main.id));
  seen = []; expect(await (await import("./client")).chatComplete({ workspaceId: WS, kind: "draft", system: "Help", user: "Hello" })).toBeNull();
  expect(seen.map(r => r.model)).toEqual([`http-${status}`]);
});
it("uses native Claude as a replacement and stops on an unreadable saved key", async () => {
  await add(); await add("backup"); const [main, backup] = await rows();
  await db.update(s.aiProviders).set({ model: "http-500" }).where(eq(s.aiProviders.id, main.id));
  await db.update(s.aiProviders).set({ provider: "anthropic" }).where(eq(s.aiProviders.id, backup.id));
  seen = []; expect(await (await import("./client")).chatComplete({ workspaceId: WS, kind: "draft", system: "Help", user: "Hello" })).toBeTruthy();
  expect(seen[1].path).toBe("/v1/messages");
  await db.update(s.aiProviders).set({ api_key_encrypted: "invalid" }).where(eq(s.aiProviders.id, main.id));
  seen = []; await expect(store.storedProviderChain()).rejects.toThrow(); expect(seen).toEqual([]);
});
it("retains environment defaults for an empty list", async () => {
  process.env.AI_API_KEY = KEY; process.env.AI_BASE_URL = base; process.env.AI_PROVIDER = "custom"; process.env.AI_MODEL = "env";
  await store.migrateInstanceProviders(); expect(await rows()).toEqual([]);
  expect((await (await import("./client")).buildProviderChain())[0].model).toBe("env");
});
it("imports legacy aliases without discarding their configuration", async () => {
  const { encryptString } = await import("../crypto");
  await db.insert(s.instanceSettings).values([['OPENAI_API_KEY', KEY], ['OPENAI_BASE_URL', base], ['AI_REPHRASE_MODEL', 'legacy-alias']].map(([key, value]) => ({ key, value_encrypted: encryptString(value) })));
  await store.migrateInstanceProviders();
  expect((await store.storedProviderChain())?.[0]).toMatchObject({ apiKey: KEY, baseUrl: base, model: 'legacy-alias' });
});
it("keeps all legacy values when an import cannot decrypt a key", async () => {
  await db.insert(s.instanceSettings).values({ key: 'AI_API_KEY', value_encrypted: 'invalid' });
  await expect(store.migrateInstanceProviders()).rejects.toThrow();
  expect(await db.select().from(s.instanceSettings)).toHaveLength(1);
  expect(await db.select().from(s.aiProviders)).toHaveLength(0);
});
it("opens a fresh connection form after an edit was closed", async () => {
  const saved = (await add()).body.data;
  const headers = { cookie };
  expect((await app.request(`/settings/ai/providers/edit/${saved.id}`, { headers })).status).toBe(200);
  const response = await app.request('/settings/ai/providers/connect', { headers });
  expect(response.status).toBe(200);
  const html = await response.text(); expect(html).toContain('aria-label="Connect AI provider"');
  expect(html).not.toContain('name="id"');
});
it("tests a saved provider without a request body", async () => {
  const saved = (await add()).body.data;
  const response = await request("POST", `/${saved.id}/test`);
  expect(response.status).toBe(200); expect(response.body.data.ok).toBe(true);
});
