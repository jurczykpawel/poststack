import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { inArray, eq } from "drizzle-orm";
import { workspaces, channels, contacts, apiKeys, tags, conversations, messages } from "@/db/schema";
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

  // held_count is now a single grouped count joined by a Map (not a join-count per
  // channel). Verify it maps the count to the right channel: a channel with held messages reports
  // them, while one without reports 0.
  it("reports held_count per channel via the grouped count", async () => {
    if (!TEST_DB) return;
    const [conv] = await db.insert(conversations).values({ workspace_id: WS_A, channel_id: CH_A, contact_id: CONTACT_A, platform: "facebook", status: "open" }).returning({ id: conversations.id });
    await db.insert(messages).values([
      { conversation_id: conv.id, direction: "outbound", status: "held", text: "a" },
      { conversation_id: conv.id, direction: "outbound", status: "held", text: "b" },
      { conversation_id: conv.id, direction: "outbound", status: "sent", text: "c" },
    ]);
    const body = await (await app.request("/api/v1/channels", { headers: authHeaders })).json();
    const ch = (body.data as Array<{ id: string; held_count: number }>).find((c) => c.id === CH_A);
    expect(ch!.held_count).toBe(2); // only the two held, not the sent one
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

  it("returns 409 (not 500) when reactivating a channel whose account is active in another workspace", async () => {
    if (!TEST_DB) return;
    const SHARED = "PAGE_SHARED_SEC15";
    const CH_A_DIS = "dddddddd-0000-0000-0000-0000000000d1";
    const CH_B_ACT = "dddddddd-0000-0000-0000-0000000000d2";
    // WS_B owns the account live; WS_A has only a disabled row for the same account.
    await db.insert(channels).values({ id: CH_B_ACT, workspace_id: WS_B, platform: "facebook", platform_id: SHARED, token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "wb", status: "active" });
    await db.insert(channels).values({ id: CH_A_DIS, workspace_id: WS_A, platform: "facebook", platform_id: SHARED, token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "wa", status: "disabled" });
    try {
      const res = await app.request(`/api/v1/channels/${CH_A_DIS}`, {
        method: "PATCH",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      expect(res.status).toBe(409);
      // The DB rejected the reactivation, so WS_A's channel stays disabled.
      const row = await db.query.channels.findFirst({ where: eq(channels.id, CH_A_DIS), columns: { status: true } });
      expect(row?.status).toBe("disabled");
    } finally {
      await db.delete(channels).where(inArray(channels.id, [CH_A_DIS, CH_B_ACT]));
    }
  });

  it("omits webhook_secret from the channel detail response (machine-only field)", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/api/v1/channels/${CH_A}`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(CH_A);
    expect(body.data).not.toHaveProperty("webhook_secret");
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

  // an unbounded retention value would push the cron's cutoff Date out of range and throw,
  // taking down retention for every tenant; the bound rejects it as a 422 before persisting.
  it("rejects an over-max retention value (422), not persisting a cron-poisoning value", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/workspace", {
      method: "PATCH",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ message_retention_days: 1_000_000_000_000 }),
    });
    expect(res.status).toBe(422);
  });

  // the manual prune's older_than_days is bounded the same way (else RangeError → 500).
  it("rejects an over-max older_than_days on prune (422)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/messages/prune", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ older_than_days: 1_000_000_000_000 }),
    });
    expect(res.status).toBe(422);
  });

  // webhook-events/prune is bounded the same way.
  it("rejects an over-max older_than_days on webhook-events prune (422)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/webhook-events/prune", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ older_than_days: 1_000_000_000_000 }),
    });
    expect(res.status).toBe(422);
  });

  it("prunes webhook_events older than the cutoff, scoped to the workspace's channels", async () => {
    if (!TEST_DB) return;
    const { webhookEvents } = await import("@/db/schema");
    const now = Date.now();
    await db.insert(webhookEvents).values([
      { event_key: `we-old-${now}`, event_type: "message", raw: {}, channel_id: CH_A, received_at: new Date(now - 40 * 86_400_000) },
      { event_key: `we-new-${now}`, event_type: "message", raw: {}, channel_id: CH_A, received_at: new Date(now - 1 * 86_400_000) },
    ]);
    const res = await app.request("/api/v1/webhook-events/prune", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ older_than_days: 30 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deletedEvents).toBeGreaterThanOrEqual(1);
    expect(await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.event_key, `we-old-${now}`) })).toBeUndefined();
    expect(await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.event_key, `we-new-${now}`) })).toBeDefined();
    await db.delete(webhookEvents).where(eq(webhookEvents.event_key, `we-new-${now}`));
  });

  // The prune floor (7d) keeps a recent dedup claim alive past any platform redelivery window.
  it("rejects an older_than_days below the redelivery-safe floor (422)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/webhook-events/prune", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ older_than_days: 1 }),
    });
    expect(res.status).toBe(422);
  });

  // An orphan row (channel_id NULL — e.g. left by another tenant's deleted channel, FK SET NULL) is
  // unowned, so a workspace prune must NOT delete it (else cross-tenant log/dedup deletion).
  it("does not prune an orphan (channel_id NULL) row", async () => {
    if (!TEST_DB) return;
    const { webhookEvents } = await import("@/db/schema");
    const now = Date.now();
    await db.insert(webhookEvents).values({ event_key: `we-orphan-${now}`, event_type: "message", raw: {}, channel_id: null, received_at: new Date(now - 100 * 86_400_000) });
    const res = await app.request("/api/v1/webhook-events/prune", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ older_than_days: 30 }),
    });
    expect(res.status).toBe(200);
    expect(await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.event_key, `we-orphan-${now}`) })).toBeDefined();
    await db.delete(webhookEvents).where(eq(webhookEvents.event_key, `we-orphan-${now}`));
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

  it("a sequences:read-scoped key can list sequences (GET /sequences requires :read, not :write)", async () => {
    if (!TEST_DB) return;
    const SEQ_KEY = "rs_live_seqread_key_0123456789abcd";
    await db.insert(apiKeys).values({
      workspace_id: WS_A, name: "sequence reader",
      key_hash: createHash("sha256").update(SEQ_KEY).digest("hex"),
      key_prefix: "rs_live_seq", scopes: ["sequences:read"],
    });
    const res = await app.request("/api/v1/sequences", { headers: { authorization: `Bearer ${SEQ_KEY}` } });
    expect(res.status).toBe(200);
  });

  // two concurrent same-name POST /tags must not 500: the loser of the read-then-write
  // race gets a clean 409 (conflict-aware insert on the (workspace_id, name) unique index), not an
  // uncaught 23505. Exactly one tag is created.
  it("two concurrent same-name POST /tags yield one 201 + one 409 (no 500)", async () => {
    if (!TEST_DB) return;
    const mk = () =>
      app.request("/api/v1/tags", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "race-tag" }),
      });
    const [a, b] = await Promise.all([mk(), mk()]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const rows = await db.query.tags.findMany({ where: eq(tags.workspace_id, WS_A) });
    expect(rows.filter((t) => t.name === "race-tag").length).toBe(1);
  });
});
