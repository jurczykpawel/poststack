import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// LANDING1 route wiring against the real app: `/` serves the marketing page to anonymous visitors,
// redirects a logged-in session to /overview, and serves the landing's static assets. The landing
// build is faked via LANDING_DIST_DIR so no Astro build is needed.
const TEST_DB = process.env.TEST_DATABASE_URL;
let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;
let dir = "";

const WS = "eeeeeeee-0000-0000-0000-0000000000b1";
const USER = "eeeeeeee-0000-0000-0000-0000000000b2";

beforeAll(async () => {
  if (!TEST_DB) return;
  dir = mkdtempSync(join(tmpdir(), "landing-it-"));
  process.env.LANDING_DIST_DIR = dir;
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><html><head></head><body><h1>Landing marketing page</h1></body></html>",
  );
  mkdirSync(join(dir, "_astro"));
  writeFileSync(join(dir, "_astro", "site.abc.css"), "body{}");
  mkdirSync(join(dir, "privacy"));
  writeFileSync(
    join(dir, "privacy", "index.html"),
    "<!doctype html><html><head></head><body><h1>Privacy Policy</h1></body></html>",
  );

  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  cookie = `session=${await signSession(USER, WS)}`;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  delete process.env.LANDING_DIST_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
  await db.$client.end();
});

describe("LANDING1 route wiring", () => {
  it("serves the marketing landing at / for an anonymous visitor", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Landing marketing page");
  });

  it("redirects a logged-in visitor from / to /overview", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/", { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/overview");
  });

  it("serves landing static assets", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/_astro/site.abc.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });

  it("does not shadow app routes — /login still renders", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("</html>");
  });

  it("serves the /privacy sub-page", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Privacy Policy");
  });

  it("injects window.__POSTSTACK_ANALYTICS__ only when analytics env is set", async () => {
    if (!TEST_DB) return;
    // No env → no injection.
    expect(await (await app.request("/")).text()).not.toContain("__POSTSTACK_ANALYTICS__");

    // Env set → config injected into <head> at request time (read live, no rebuild).
    process.env.LANDING_UMAMI_WEBSITE_ID = "umami-test-id";
    process.env.LANDING_GTM_ID = "GTM-TEST123";
    try {
      const body = await (await app.request("/")).text();
      expect(body).toContain("window.__POSTSTACK_ANALYTICS__=");
      expect(body).toContain("umami-test-id");
      expect(body).toContain("GTM-TEST123");
    } finally {
      delete process.env.LANDING_UMAMI_WEBSITE_ID;
      delete process.env.LANDING_GTM_ID;
    }
  });
});
