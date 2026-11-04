import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// MQA18-B05: a NUL character in any text field made Postgres throw (22021 for text, 22P05 for jsonb)
// and the global onError turned it into a 500. One mapping in onError → 422, for API and panel alike.
const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_nul_input_key_0123456789abcd";
const WS = "cccccccc-0000-0000-0000-0000000000e1";
const USER = "cccccccc-0000-0000-0000-0000000000e2";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;
let cookie: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  app = (await import("./app")).buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "N", slug: `n-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_nul" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.instanceLicense);
});

describe("NUL character in text input", () => {
  it("API: text column (22021) → 422 JSON envelope, nothing saved", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/tags", {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "bad\u0000name" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.data).toBeNull();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/NUL/);
  });

  it("panel: text column (22021) on a dashboard form → 422 with a toast (not a 500 page), nothing saved", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings/alert-webhook", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "hx-request": "true" },
      body: JSON.stringify({ url: "https://example.com/hook\u0000x", enabled: "true" }),
    });
    expect(res.status).toBe(422);
    expect(res.headers.get("hx-trigger")).toContain("NUL");
    expect(await db.query.alertWebhooks.findFirst({ where: eq(s.alertWebhooks.workspace_id, WS) })).toBeUndefined();
  });

  it("jsonb (22P05) is mapped the same way", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/rules", {
      method: "POST",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "R2", trigger_type: "keyword", trigger_config: { keywords: ["a"] }, response_type: "text", response_config: { text: "bad\u0000text" } }),
    });
    expect(res.status).toBe(422);
  });
});
