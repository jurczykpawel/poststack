import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { inArray } from "drizzle-orm";
import { workspaces, channels, contacts, apiKeys } from "@/db/schema";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_v1_integration_key_abcdef0123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let app: Hono;

const WS_A = "dddddddd-0000-0000-0000-00000000000a";
const WS_B = "dddddddd-0000-0000-0000-00000000000b";
const CH_A = "dddddddd-0000-0000-0000-0000000000c1";
const CONTACT_A = "dddddddd-0000-0000-0000-0000000000a1";
const CONTACT_B = "dddddddd-0000-0000-0000-0000000000b1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";

  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  const { buildApp } = await import("../app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.insert(workspaces).values({ id: WS_A, name: "A", slug: `a-${WS_A}` });
  await db.insert(workspaces).values({ id: WS_B, name: "B", slug: `b-${WS_B}` });
  await db.insert(channels).values({
    id: CH_A, workspace_id: WS_A, platform: "facebook", platform_id: "PAGE_A",
    display_name: "Page A", token_encrypted: encryptTokens({ access_token: "tok" }),
    webhook_secret: "wh", status: "active",
  });
  await db.insert(contacts).values({ id: CONTACT_A, workspace_id: WS_A });
  await db.insert(contacts).values({ id: CONTACT_B, workspace_id: WS_B });
  await db.insert(apiKeys).values({
    workspace_id: WS_A, name: "A key",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: "rs_live_v1_in",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(inArray(workspaces.id, [WS_A, WS_B]));
  await db.$client.end();
});

const authHeaders = { authorization: `Bearer ${RAW_KEY}` };

describe("v1 delegation parity (real Postgres)", () => {
  it("lists channels for the key's workspace with the {data} envelope", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/channels", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeNull();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.map((c: { id: string }) => c.id)).toContain(CH_A);
    expect(body.data[0]).toHaveProperty("is_active", true);
  });

  it("reads an own-workspace contact (param passed through)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/contacts/${CONTACT_A}`, { headers: authHeaders });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a cross-workspace contact (no leak)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/contacts/${CONTACT_B}`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it("patches a channel display name", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/channels/${CH_A}`, {
      method: "PATCH",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.display_name).toBe("Renamed");
  });

  it("returns the workspace settings", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/workspace", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(WS_A);
  });

  it("validates request bodies (422 on bad rule payload)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/rules", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(422);
  });

  it("deletes a channel (204)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/channels/${CH_A}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(204);
  });

  it("rejects an unknown key (401)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/channels", {
      headers: { authorization: "Bearer rs_live_nope" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the audit log", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/audit-log", { headers: authHeaders });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).data)).toBe(true);
  });

  it("updates the workspace retention policy (PATCH)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/workspace", {
      method: "PATCH",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ message_retention_days: 30 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.message_retention_days).toBe(30);
  });

  it("force-drains a channel (200)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/channels/${CH_A}/drain`, { method: "POST", headers: authHeaders });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("data.enqueued");
  });

  it("deletes a contact (204)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/contacts/${CONTACT_A}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
  });
});

describe("api-key management is session-only + scope catalog (real Postgres)", () => {
  it("rejects api-key auth on key management routes (403)", async () => {
    if (!TEST_DB) return;
    const list = await app.request("/api/v1/api-keys", { headers: authHeaders });
    expect(list.status).toBe(403);
    const create = await app.request("/api/v1/api-keys", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "escalate", scopes: [] }),
    });
    expect(create.status).toBe(403);
    const del = await app.request(`/api/v1/api-keys/${CONTACT_A}`, { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(403);
  });

  it("a tags:read-scoped key can list tags (GET /tags requires tags:read, not tags:write)", async () => {
    if (!TEST_DB) return;
    const TAGS_KEY = "rs_live_tagsread_key_0123456789abcd";
    await db.insert(apiKeys).values({
      workspace_id: WS_A, name: "tags reader",
      key_hash: createHash("sha256").update(TAGS_KEY).digest("hex"),
      key_prefix: "rs_live_tags", scopes: ["tags:read"],
    });
    const res = await app.request("/api/v1/tags", { headers: { authorization: `Bearer ${TAGS_KEY}` } });
    expect(res.status).toBe(200);
  });
});
