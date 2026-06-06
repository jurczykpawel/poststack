import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_v1_integration_key_abcdef0123";

let prisma: typeof import("@/lib/prisma").prisma;
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

  ({ prisma } = await import("@/lib/prisma"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  const { buildApp } = await import("../app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.workspace.create({ data: { id: WS_A, name: "A", slug: `a-${WS_A}` } });
  await prisma.workspace.create({ data: { id: WS_B, name: "B", slug: `b-${WS_B}` } });
  await prisma.channel.create({
    data: {
      id: CH_A, workspace_id: WS_A, platform: "facebook", platform_id: "PAGE_A",
      display_name: "Page A", token_encrypted: encryptTokens({ access_token: "tok" }),
      webhook_secret: "wh", status: "active",
    },
  });
  await prisma.contact.create({ data: { id: CONTACT_A, workspace_id: WS_A } });
  await prisma.contact.create({ data: { id: CONTACT_B, workspace_id: WS_B } });
  await prisma.apiKey.create({
    data: {
      workspace_id: WS_A, name: "A key",
      key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
      key_prefix: "rs_live_v1_in",
    },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } });
  await prisma.$disconnect();
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
});
