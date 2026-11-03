import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import type { Hono } from "hono";
import openaiModels from "@/lib/ai/__fixtures__/openai-models.json";
import openaiChat from "@/lib/ai/__fixtures__/openai-chat.json";

// AIPROVIDER1: /api/v1/settings/ai — scopes, operator binding, key-leak rule, verify-before-save, SSRF policy.
// The provider is a local fake speaking the OpenAI wire format (recorded shapes in src/lib/ai/__fixtures__),
// reachable only because the test lists it in AI_ALLOWED_PRIVATE_TARGETS (which also proves that policy).
const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "a1a1a1a1-0000-0000-0000-0000000000c1";
const OP = "a1a1a1a1-0000-0000-0000-0000000000c2";
const OTHER = "a1a1a1a1-0000-0000-0000-0000000000c3";
const GOOD = "sk-test-0123456789abcdefABCD";
const RAW = (n: string) => `sk_live_aiprovider_${n}_0123456789abcdef0123456789abcdef`;
const KEYS: Record<string, { scopes: string[]; creator: string | null }> = {
  op: { scopes: ["instance_ai:read", "instance_ai:write"], creator: OP },
  readonly: { scopes: ["instance_ai:read"], creator: OP },
  nonop: { scopes: ["instance_ai:read", "instance_ai:write"], creator: OTHER },
  orphan: { scopes: ["instance_ai:read", "instance_ai:write"], creator: null },
  full: { scopes: [], creator: OP },
  settings: { scopes: ["settings:read", "settings:write"], creator: OP },
};
const bearer = (n: string) => ({ authorization: `Bearer ${RAW(n)}` });

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cfg: typeof import("@/lib/settings/config");
let models: typeof import("@/lib/ai/models");
let server: Server;
let BASE = "";
let seen: Array<{ method: string; path: string; authorization?: string }> = [];
let operatorCookie: { cookie: string };
let otherCookie: { cookie: string };

const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await app.request(`/api/v1/settings/ai${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  expect(text, "a response must never contain the API key").not.toContain(GOOD);
  return { status: res.status, body: JSON.parse(text) };
};
const putCustom = (extra: Record<string, unknown> = {}, who = "op") =>
  call("PUT", "", bearer(who), { provider: "custom", base_url: BASE, model: "gpt-4o-mini", api_key: GOOD, ...extra });
const stored = async (key: string) => cfg.getConfig(key as "AI_MODEL", { fresh: true });

beforeAll(async () => {
  if (!TEST_DB) return;
  server = createServer((req, res) => {
    seen.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization });
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${GOOD}`) return json(401, { error: { message: "bad key sk-leak-from-provider" } });
    if (req.url === "/v1/models") return json(200, openaiModels);
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => (JSON.parse(raw).model === "missing-model" ? json(404, { error: { message: "no such model" } }) : json(200, openaiChat)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  process.env.AI_ALLOWED_PRIVATE_TARGETS = new URL(BASE).host;
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB, JWT_SECRET: "test-secret-at-least-32-characters-long", APP_URL: "http://localhost:3000",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000001", CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
  });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  cfg = await import("@/lib/settings/config");
  models = await import("@/lib/ai/models");
  Object.assign((await import("@/lib/env")).env, { INSTANCE_ADMIN_EMAILS: `op-${OP}@test.local` });
  const { signSession } = await import("@/lib/auth");
  operatorCookie = { cookie: `session=${await signSession(OP, WS)}` };
  otherCookie = { cookie: `session=${await signSession(OTHER, WS)}` };
  app = (await import("@/server/app")).buildApp();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  for (const id of [OP, OTHER]) await db.delete(s.users).where(eq(s.users.id, id));
  await db.insert(s.users).values([{ id: OP, email: `op-${OP}@test.local` }, { id: OTHER, email: `o-${OTHER}@test.local` }]);
  await db.insert(s.workspaces).values({ id: WS, name: "AIP", slug: `aip-${WS}` });
  await db.insert(s.workspaceMembers).values([{ workspace_id: WS, user_id: OP, role: "owner" }, { workspace_id: WS, user_id: OTHER, role: "owner" }]);
  for (const [name, k] of Object.entries(KEYS)) {
    await db.insert(s.apiKeys).values({ workspace_id: WS, name, key_hash: createHash("sha256").update(RAW(name)).digest("hex"), key_prefix: "sk_live_aiprov", scopes: k.scopes, created_by_user_id: k.creator });
  }
});

beforeEach(async () => {
  if (!TEST_DB) return;
  seen = [];
  await db.delete(s.instanceSettings).where(like(s.instanceSettings.key, "AI_%"));
  await db.delete(s.rateLimitCounters).where(like(s.rateLimitCounters.key, "rl:ai-%"));
  cfg.invalidateConfigCache();
  models.clearModelCache();
  delete process.env.AI_API_KEY;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.instanceSettings).where(like(s.instanceSettings.key, "AI_%"));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  for (const id of [OP, OTHER]) await db.delete(s.users).where(eq(s.users.id, id));
  delete process.env.AI_ALLOWED_PRIVATE_TARGETS;
  server.close();
  await db.$client.end();
});

describe("access control", () => {
  it("needs authentication", async () => {
    if (!TEST_DB) return;
    expect((await call("GET", "", {})).status).toBe(401);
  });

  it.each([
    ["an operator session", () => operatorCookie, 200],
    ["a key with instance_ai scopes made by the operator", () => bearer("op"), 200],
    ["a read-only instance key", () => bearer("readonly"), 200],
    ["a non-operator session", () => otherCookie, 403],
    ["a key made by a non-operator", () => bearer("nonop"), 403],
    ["a key with no recorded creator", () => bearer("orphan"), 403],
    ["a full-access key (empty scopes never imply instance_*)", () => bearer("full"), 403],
    ["a key with only settings:* scopes", () => bearer("settings"), 403],
  ])("GET: %s", async (_name, headers, status) => {
    if (!TEST_DB) return;
    expect((await call("GET", "", headers())).status).toBe(status);
  });

  it("a read-only key cannot change anything", async () => {
    if (!TEST_DB) return;
    expect((await putCustom({}, "readonly")).body.error.code).toBe("insufficient_scope");
    expect((await call("DELETE", "", bearer("readonly"))).status).toBe(403);
    expect((await call("POST", "/test", bearer("readonly"), {})).status).toBe(403);
  });

  it("a key loses its power the moment its creator stops being an operator", async () => {
    if (!TEST_DB) return;
    expect((await call("GET", "", bearer("op"))).status).toBe(200);
    const env = (await import("@/lib/env")).env;
    const before = env.INSTANCE_ADMIN_EMAILS;
    Object.assign(env, { INSTANCE_ADMIN_EMAILS: "someone-else@test.local" });
    try {
      expect((await call("GET", "", bearer("op"))).status).toBe(403);
    } finally {
      Object.assign(env, { INSTANCE_ADMIN_EMAILS: before });
    }
  });
});

describe("GET /settings/ai", () => {
  it("describes the catalog and the unconfigured state", async () => {
    if (!TEST_DB) return;
    const { body } = await call("GET", "", bearer("op"));
    expect(body.data).toMatchObject({ configured: false, provider: "openai", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: { set: false, source: "unset", hint: null } });
    expect(body.data.providers.map((p: { id: string }) => p.id)).toEqual(["openai", "anthropic", "openrouter", "groq", "custom"]);
    expect(body.data.providers[2]).toMatchObject({ id: "openrouter", models_need_key: false });
  });
});

describe("PUT /settings/ai", () => {
  it("verifies, saves a custom provider and never echoes the key (only a 4-character hint)", async () => {
    if (!TEST_DB) return;
    const { status, body } = await putCustom();
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ configured: true, provider: "custom", base_url: BASE, model: "gpt-4o-mini", api_key: { set: true, source: "db", hint: "ABCD" } });
    expect(await stored("AI_API_KEY")).toBe(GOOD);
    expect(await stored("AI_PROVIDER")).toBe("custom");
    expect(seen.map((r) => r.path)).toEqual(["/v1/chat/completions"]); // the test call happened before saving
    const audit = await db.query.auditLogs.findFirst({ where: eq(s.auditLogs.action, "settings.ai.updated") });
    expect(JSON.stringify(audit?.metadata)).toContain("custom");
  });

  it("writes nothing when the verification fails (wrong key → invalid_key with the HTTP status, provider text hidden)", async () => {
    if (!TEST_DB) return;
    const { status, body } = await putCustom({ api_key: "sk-wrong-0123456789abcdefghij" });
    expect(status).toBe(422);
    expect(body.error).toMatchObject({ code: "invalid_key", details: { http_status: 401 } });
    expect(JSON.stringify(body)).not.toContain("sk-leak-from-provider");
    expect(await stored("AI_PROVIDER")).toBe("");
  });

  it("reports model_not_found for an unknown model, and skips the test with verify:false", async () => {
    if (!TEST_DB) return;
    expect((await putCustom({ model: "missing-model" })).body.error.code).toBe("model_not_found");
    expect((await putCustom({ model: "missing-model", verify: false })).status).toBe(200);
    expect(await stored("AI_MODEL")).toBe("missing-model");
  });

  it("changing only the model reuses the saved key (it goes to the same host)", async () => {
    if (!TEST_DB) return;
    await putCustom();
    seen = [];
    const { status } = await call("PUT", "", bearer("op"), { provider: "custom", base_url: BASE, model: "other-model" });
    expect(status).toBe(200);
    expect(seen[0]!.authorization).toBe(`Bearer ${GOOD}`);
    expect(await stored("AI_MODEL")).toBe("other-model");
  });

  it("changing the provider or the host without a key is refused — the saved key is never forwarded", async () => {
    if (!TEST_DB) return;
    await putCustom();
    seen = [];
    const toGroq = await call("PUT", "", bearer("op"), { provider: "groq", model: "llama-3.3-70b-versatile" });
    expect(toGroq.status).toBe(422);
    expect(toGroq.body.error.code).toBe("API_KEY_REQUIRED");
    const otherHost = await call("PUT", "", bearer("op"), { provider: "custom", base_url: "http://attacker.example:9/v1", model: "m" });
    expect(otherHost.body.error.code).toBe("API_KEY_REQUIRED");
    expect(seen).toEqual([]);
    expect(await stored("AI_PROVIDER")).toBe("custom");
    expect(await stored("AI_BASE_URL")).toBe(BASE);
  });

  it("a first-time save needs a key too", async () => {
    if (!TEST_DB) return;
    expect((await call("PUT", "", bearer("op"), { provider: "custom", base_url: BASE, model: "m" })).body.error.code).toBe("API_KEY_REQUIRED");
  });

  it("presets take no Base URL; custom needs a valid one", async () => {
    if (!TEST_DB) return;
    expect((await call("PUT", "", bearer("op"), { provider: "groq", base_url: BASE, model: "m", api_key: GOOD, verify: false })).body.error.code).toBe("BASE_URL_NOT_ALLOWED");
    expect((await call("PUT", "", bearer("op"), { provider: "custom", model: "m", api_key: GOOD, verify: false })).body.error.code).toBe("BASE_URL_REQUIRED");
    expect((await call("PUT", "", bearer("op"), { provider: "custom", base_url: "https://u:p@x.example/v1", model: "m", api_key: GOOD, verify: false })).body.error.code).toBe("INVALID_BASE_URL");
  });

  it("a preset ignores and clears a stored custom URL; its catalog URL is used", async () => {
    if (!TEST_DB) return;
    await putCustom();
    const { body } = await call("PUT", "", bearer("op"), { provider: "groq", model: "llama-3.3-70b-versatile", api_key: GOOD, verify: false });
    expect(body.data).toMatchObject({ provider: "groq", base_url: "https://api.groq.com/openai/v1" });
    expect(await stored("AI_BASE_URL")).toBe("");
  });

  it("validates the body (unknown provider, bad model, whitespace in key)", async () => {
    if (!TEST_DB) return;
    for (const bad of [{ provider: "nope", model: "m" }, { provider: "custom", model: "has space", base_url: BASE }, { provider: "groq", model: "m", api_key: "a b" }, {}]) {
      expect((await call("PUT", "", bearer("op"), bad)).status, JSON.stringify(bad)).toBe(422);
    }
  });

  it("refuses private and metadata targets that are not on the allow-list, and says how to allow one", async () => {
    if (!TEST_DB) return;
    const loopback = await call("PUT", "", bearer("op"), { provider: "custom", base_url: "http://127.0.0.1:9/v1", model: "m", api_key: GOOD });
    expect(loopback.body.error.code).toBe("blocked_target");
    expect(loopback.body.error.message).toContain("AI_ALLOWED_PRIVATE_TARGETS");
    const meta = await call("PUT", "", bearer("op"), { provider: "custom", base_url: "http://169.254.169.254/v1", model: "m", api_key: GOOD });
    expect(meta.body.error.code).toBe("blocked_target");
  });
});

describe("DELETE /settings/ai", () => {
  it("removes the stored values", async () => {
    if (!TEST_DB) return;
    await putCustom();
    const { body } = await call("DELETE", "", bearer("op"));
    expect(body.data).toMatchObject({ configured: false, provider: "openai", api_key: { set: false } });
    expect(await stored("AI_API_KEY")).toBe("");
  });
});

describe("POST /settings/ai/models", () => {
  it("lists a candidate's chat models before anything is saved, then serves them from cache", async () => {
    if (!TEST_DB) return;
    const first = await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD });
    expect(first.body.data.models.map((m: { id: string }) => m.id).sort()).toEqual(["gpt-4o-mini", "o3-mini"]);
    expect(first.body.data).toMatchObject({ cached: false, filtered_out: 5 });
    const second = await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD });
    expect(second.body.data.cached).toBe(true);
    expect((await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD, refresh: true })).body.data.cached).toBe(false);
    expect((await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD, all: true })).body.data.models).toHaveLength(7);
    expect(await stored("AI_PROVIDER")).toBe(""); // nothing saved
  });

  it("uses the saved key for the saved target, but never for another host", async () => {
    if (!TEST_DB) return;
    await putCustom();
    seen = [];
    expect((await call("POST", "/models", bearer("op"), {})).status).toBe(200);
    expect(seen[0]!.authorization).toBe(`Bearer ${GOOD}`);
    const moved = await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE.replace("127.0.0.1", "localhost") });
    expect(seen.slice(1).every((r) => r.authorization === undefined)).toBe(true);
    expect(moved.body.error?.code).not.toBe(undefined); // no key → refused or invalid_key, never a silent success
  });

  it("maps a wrong key to invalid_key and throttles at 10 requests a minute", async () => {
    if (!TEST_DB) return;
    const bad = await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: "sk-wrong-0123456789abcdefghij" });
    expect(bad.body.error).toMatchObject({ code: "invalid_key", details: { http_status: 401 } });
    for (let i = 0; i < 9; i++) await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD });
    expect((await call("POST", "/models", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD })).status).toBe(429);
  });
});

describe("POST /settings/ai/test", () => {
  it("reports ok with latency, and a failed probe as data (HTTP 200) with a human message", async () => {
    if (!TEST_DB) return;
    const ok = await call("POST", "/test", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD, model: "gpt-4o-mini" });
    expect(ok.body.data).toMatchObject({ ok: true, model: "gpt-4o-mini" });
    expect(typeof ok.body.data.latency_ms).toBe("number");
    const missing = await call("POST", "/test", bearer("op"), { provider: "custom", base_url: BASE, api_key: GOOD, model: "missing-model" });
    expect(missing.status).toBe(200);
    expect(missing.body.data).toMatchObject({ ok: false, error: { code: "model_not_found", http_status: 404 } });
    expect(missing.body.data.error.message).toContain("model");
  });

  it("refuses to probe another host with the saved key (API_KEY_REQUIRED)", async () => {
    if (!TEST_DB) return;
    await putCustom();
    seen = [];
    const r = await call("POST", "/test", bearer("op"), { provider: "groq", model: "m" });
    expect(r.body.error.code).toBe("API_KEY_REQUIRED");
    expect(seen).toEqual([]);
  });
});
