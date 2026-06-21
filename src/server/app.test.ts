import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY =
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

  // Regression guard: the login/register pages render the captcha widget, which runs its
  // proof-of-work in a blob: worker. The served CSP must permit that worker (and the widget's
  // CDN script) — otherwise the checkbox hangs on "Verifying..." and nobody can sign in. This is
  // asserted on the real served response (not the policy builder) so a CSP change can't silently
  // break login again.
  it("serves /login under a CSP the captcha widget can actually run in", async () => {
    // Render the page with captcha enabled (no DB in this test → getConfig falls back to env).
    process.env.ALTCHA_HMAC_KEY = "test-altcha-hmac-key-at-least-32-characters-long";
    const { invalidateConfigCache } = await import("@/lib/settings/config");
    invalidateConfigCache();

    const res = await app.request("/login");
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("<altcha-widget");
    expect(html).toContain("cdn.jsdelivr.net/npm/altcha");

    const csp = res.headers.get("content-security-policy") ?? "";
    const directive = (name: string): string[] => {
      const d = csp
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(`${name} `));
      return d ? d.slice(name.length + 1).split(/\s+/) : [];
    };
    expect(directive("worker-src")).toContain("blob:");
    expect(directive("script-src")).toContain("https://cdn.jsdelivr.net");
  });
});
