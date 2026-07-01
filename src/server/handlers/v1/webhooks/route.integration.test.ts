import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_webhooks_full_key_abcd000001";
const READONLY_KEY = "sk_live_webhooks_ro_key_abcd000002";
const OTHER_KEY = "sk_live_webhooks_other_key_abcd0003";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let app: Hono;

const WS = "c0ffee04-0000-4000-8000-000000000a01";
const OTHER_WS = "c0ffee04-0000-4000-8000-000000000a02";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  const { buildApp } = await import("@/server/app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await licenseInstance("pro"); // outbound_webhooks is core/pro; warm + persist a Pro token (no network)
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.insert(s.workspaces).values([
    { id: WS, name: "W", slug: `w-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await db.insert(s.apiKeys).values([
    { workspace_id: WS, name: "full", key_hash: hash(KEY), key_prefix: "sk_live_wh" },
    { workspace_id: WS, name: "ro", key_hash: hash(READONLY_KEY), key_prefix: "sk_live_wr", scopes: ["webhooks:read"] },
    { workspace_id: OTHER_WS, name: "other", key_hash: hash(OTHER_KEY), key_prefix: "sk_live_wo" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createOne(body: Record<string, unknown> = { url: "https://hook.example.com/a" }, key = KEY) {
  const res = await call("POST", "/webhooks", body, key);
  return { res, json: await res.json() };
}

describe.skipIf(!TEST_DB)("/api/v1/webhooks", () => {
  it("creates an endpoint, returns the secret once, and stores it encrypted", async () => {
    const { res, json } = await createOne({ url: "https://hook.example.com/a", event_types: ["post.published"] });
    expect(res.status).toBe(201);
    expect(json.data.url).toBe("https://hook.example.com/a");
    expect(json.data.event_types).toEqual(["post.published"]);
    expect(json.data.secret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const row = await db.query.webhookEndpoints.findFirst({ where: eq(s.webhookEndpoints.id, json.data.id) });
    expect(row!.workspace_id).toBe(WS);
    expect(row!.secret).not.toContain("whsec_"); // ciphertext at rest
  });

  it("list omits the signing secret and is workspace-scoped", async () => {
    await createOne();
    await createOne({ url: "https://other.example.com/x" }, OTHER_KEY);
    const res = await call("GET", "/webhooks");
    const { data } = await res.json();
    expect(data).toHaveLength(1); // OTHER_WS endpoint excluded
    expect(data[0].secret).toBeUndefined();
  });

  it("GET item returns the endpoint (no secret) and 404 for an unknown id", async () => {
    const { json } = await createOne();
    const got = await call("GET", `/webhooks/${json.data.id}`);
    expect(got.status).toBe(200);
    expect((await got.json()).data.secret).toBeUndefined();
    const missing = await call("GET", "/webhooks/00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
  });

  it("PATCH updates active + event types", async () => {
    const { json } = await createOne();
    const res = await call("PATCH", `/webhooks/${json.data.id}`, { active: false, event_types: ["channel.needs_reauth"] });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.active).toBe(false);
    expect(data.event_types).toEqual(["channel.needs_reauth"]);
  });

  it("rotate-secret returns a new secret distinct from the original", async () => {
    const { json } = await createOne();
    const res = await call("POST", `/webhooks/${json.data.id}/rotate-secret`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(data.secret).not.toBe(json.data.secret);
  });

  it("DELETE removes the endpoint (then GET is 404)", async () => {
    const { json } = await createOne();
    const del = await call("DELETE", `/webhooks/${json.data.id}`);
    expect(del.status).toBe(204);
    const got = await call("GET", `/webhooks/${json.data.id}`);
    expect(got.status).toBe(404);
  });

  it("accepts custom headers + extra payload fields on create; GET/list echo header NAMES only, never values", async () => {
    const { json } = await createOne({
      url: "https://hook.example.com/hdr",
      headers: { Authorization: "Bearer secret123" },
      extra_payload_fields: { source: "poststack" },
    });
    expect(json.data.header_names).toEqual(["Authorization"]);
    expect(json.data.headers).toBeUndefined(); // values never serialized
    expect(json.data.extra_payload_fields).toEqual({ source: "poststack" }); // not secret, echoed in full

    const row = await db.query.webhookEndpoints.findFirst({ where: eq(s.webhookEndpoints.id, json.data.id) });
    expect(row!.custom_headers_encrypted).not.toContain("secret123");

    const got = await call("GET", `/webhooks/${json.data.id}`);
    expect((await got.json()).data.header_names).toEqual(["Authorization"]);
  });

  it("PATCH replaces custom headers and extra payload fields", async () => {
    const { json } = await createOne({ url: "https://hook.example.com/hp", headers: { "X-Old": "1" } });
    const res = await call("PATCH", `/webhooks/${json.data.id}`, {
      headers: { "X-New": "2" },
      extra_payload_fields: { note: "hi" },
    });
    const { data } = await res.json();
    expect(data.header_names).toEqual(["X-New"]);
    expect(data.extra_payload_fields).toEqual({ note: "hi" });
  });

  it("returns 402 when the instance is not licensed for outbound webhooks", async () => {
    await gate.clearLicense();
    const res = await call("POST", "/webhooks", { url: "https://hook.example.com/nope" });
    expect(res.status).toBe(402);
  });

  it("rejects a write with a read-only key (scope) and a bad URL (422)", async () => {
    const ro = await call("POST", "/webhooks", { url: "https://hook.example.com/ro" }, READONLY_KEY);
    expect(ro.status).toBe(401); // webhooks:read key has no webhooks:write
    const bad = await call("POST", "/webhooks", { url: "ftp://evil.example.com" });
    expect(bad.status).toBe(422);
  });

  it("is tenant-isolated: another workspace's key cannot read or delete the endpoint (404)", async () => {
    const { json } = await createOne();
    const got = await call("GET", `/webhooks/${json.data.id}`, undefined, OTHER_KEY);
    expect(got.status).toBe(404);
    const del = await call("DELETE", `/webhooks/${json.data.id}`, undefined, OTHER_KEY);
    expect(del.status).toBe(404);
    expect(await db.query.webhookEndpoints.findFirst({ where: eq(s.webhookEndpoints.id, json.data.id) })).toBeTruthy();
  });
});
