import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Hono } from "hono";

// CONFIG1: the login/register pages read ALTCHA_HMAC_KEY via getConfig (captchaWidget). Pure-unit
// test (no DB) → mock getConfig to read process.env so the captcha-skip path stays DB-free.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));

let app: Hono;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  delete process.env.ALTCHA_HMAC_KEY;
  const { buildApp } = await import("../app");
  app = buildApp();
});

describe("public pages", () => {
  it("redirects / to /overview", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/overview");
  });

  it("renders the login page", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="email"');
    expect(body).toContain('name="password"');
    expect(body).toContain("Sign in");
    // The unified shell vendors htmx (no CDN) — assert the vendored asset is wired in.
    expect(body).toContain("/static/vendor/htmx-2.0.4.min.js");
  });

  it("renders the register page with a name field", async () => {
    const res = await app.request("/register");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="name"');
    expect(body).toContain("Create account");
  });
});

describe("session gating", () => {
  const DASHBOARD = ["/inbox", "/channels", "/contacts", "/rules", "/sequences", "/settings"];

  it.each(DASHBOARD)("redirects %s to /login without a session", async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("redirects to /login when the session cookie is invalid", async () => {
    const res = await app.request("/inbox", { headers: { cookie: "session=garbage" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
