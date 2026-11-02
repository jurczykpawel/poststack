import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "dddddddd-0000-0000-0000-0000000000f1";
const USER = "dddddddd-0000-0000-0000-0000000000f2";
const OTHER_WS = "dddddddd-0000-0000-0000-0000000000f3";
const OTHER_USER = "dddddddd-0000-0000-0000-0000000000f4";
const KEY = "CHANNEL_ALERT_WEBHOOK_URL";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;
let otherCookie: string;
let invalidate: () => void;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { env } = await import("@/lib/env");
  Object.assign(env, { INSTANCE_ADMIN_EMAILS: `u-${USER}@test.local` });
  ({ invalidateConfigCache: invalidate } = await import("@/lib/settings/config"));
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  otherCookie = `session=${await signSession(OTHER_USER, OTHER_WS)}`;
  await licenseInstance();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  for (const [w, u] of [[WS, USER], [OTHER_WS, OTHER_USER]]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, w));
    await db.delete(s.users).where(eq(s.users.id, u));
    await db.insert(s.users).values({ id: u, email: `u-${u}@test.local` });
    await db.insert(s.workspaces).values({ id: w, name: "M", slug: `m-${w}` });
    await db.insert(s.workspaceMembers).values({ workspace_id: w, user_id: u, role: "owner" });
  }
  await db.delete(s.instanceSettings).where(eq(s.instanceSettings.key, KEY));
  invalidate();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.instanceSettings).where(eq(s.instanceSettings.key, KEY));
  for (const [w, u] of [[WS, USER], [OTHER_WS, OTHER_USER]]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, w));
    await db.delete(s.users).where(eq(s.users.id, u));
  }
  invalidate();
  await db.$client.end();
});

const post = (body: unknown, as = cookie) =>
  app.request("/settings/credentials", { method: "POST", headers: { cookie: as, "content-type": "application/json" }, body: JSON.stringify(body) });
const page = async (as = cookie) => (await app.request("/webhooks", { headers: { cookie: as } })).text();

describe("Problem alerts card: installation fallback", () => {
  it("shows state, then edits and clears the fallback through the existing credentials route", async () => {
    if (!TEST_DB) return;
    let body = await page();
    expect(body).toContain("data-alert-fallback");
    expect(body).toContain("not set");

    expect((await post({ key: KEY, value: "https://hooks.example.com/fallback-1" })).status).toBe(200);
    body = await page();
    expect(body).toContain("set here");
    expect(body).toContain("https://hooks.example.com/fallback-1");
    expect(body).toContain("Clear fallback");

    await post({ key: KEY, value: "https://hooks.example.com/fallback-2" });
    body = await page();
    expect(body).toContain("https://hooks.example.com/fallback-2");
    expect(body).not.toContain("https://hooks.example.com/fallback-1");

    await post({ key: KEY, clear: "1" });
    body = await page();
    expect(body).not.toContain("fallback-2");
    expect(body).not.toContain("Clear fallback");
    expect(await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, KEY) })).toBeUndefined();
  });

  it("hides the fallback from non-operators and refuses their writes", async () => {
    if (!TEST_DB) return;
    await post({ key: KEY, value: "https://hooks.example.com/secret-fallback" });
    const body = await page(otherCookie);
    expect(body).not.toContain("data-alert-fallback");
    expect(body).not.toContain("secret-fallback");
    expect((await post({ key: KEY, clear: "1" }, otherCookie)).status).toBe(403);
  });
});
