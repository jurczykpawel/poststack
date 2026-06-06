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
  const { buildApp } = await import("./app");
  app = buildApp();
});

describe("Hono app skeleton — public routes + global middleware", () => {
  it("serves Scalar docs HTML at /api/docs", async () => {
    const res = await app.request("/api/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("api-reference");
  });

  it("serves the OpenAPI spec at /api/v1 with CORS", async () => {
    const res = await app.request("/api/v1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body).toHaveProperty("openapi");
  });

  it("returns 503 for captcha challenge when ALTCHA_HMAC_KEY is unset", async () => {
    delete process.env.ALTCHA_HMAC_KEY;
    const res = await app.request("/api/captcha/challenge");
    expect(res.status).toBe(503);
  });

  it("applies security headers to every response", async () => {
    const res = await app.request("/api/docs");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("sets Cache-Control no-store on /api/* responses", async () => {
    const res = await app.request("/api/docs");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("answers CORS preflight on /api/v1/* with allowed methods", async () => {
    const res = await app.request("/api/v1/channels", { method: "OPTIONS" });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("returns 404 for an unknown route", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
  });
});
