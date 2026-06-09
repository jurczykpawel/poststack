import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-token";
  process.env.META_APP_SECRET = "app-secret";
  const { buildApp } = await import("../app");
  app = buildApp();
});

describe("auth routes", () => {
  it("logout clears the session cookie without a DB hit", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("rs_session=");
    expect(setCookie.toLowerCase()).toMatch(/max-age=0|expires=/);
  });
});

describe("webhook verification", () => {
  it("echoes hub.challenge when the verify token matches", async () => {
    const res = await app.request(
      "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=42",
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("returns 403 when the verify token does not match", async () => {
    const res = await app.request(
      "/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
    );
    expect(res.status).toBe(403);
  });

  it("rejects a POST with a bad signature (403)", async () => {
    const res = await app.request("/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify({ object: "page", entry: [] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("oauth routes", () => {
  it("oauth initiate requires authentication (401)", async () => {
    const res = await app.request("/api/oauth/facebook");
    expect(res.status).toBe(401);
  });

  it("oauth callback redirects to /channels on missing params", async () => {
    const res = await app.request("/api/oauth/facebook/callback");
    expect([302, 307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toContain("/channels?error=missing_params");
  });
});

describe("cron route", () => {
  it("rejects without the cron secret (403)", async () => {
    const res = await app.request("/api/cron/token-refresh");
    expect(res.status).toBe(403);
  });

  //  — a wrong secret of a DIFFERENT length is still 403 (the hash-compare doesn't
  // short-circuit on length, so it leaks no length oracle).
  it("rejects a wrong secret of a different length (403)", async () => {
    for (const bad of ["x", "x".repeat(8), "x".repeat(200)]) {
      const res = await app.request("/api/cron/token-refresh", { headers: { "x-cron-secret": bad } });
      expect(res.status).toBe(403);
    }
  });
});
