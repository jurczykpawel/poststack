import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "./security-headers";

/** Build a minimal app with the middleware mounted, and return the response for `path`. */
async function respond(path = "/") {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/", (c) => c.text("ok"));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  return app.request(path);
}

describe("securityHeaders", () => {
  it("sets the core hardening headers", async () => {
    const res = await respond();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("emits a CSP that locks default-src to self", async () => {
    const csp = (await respond()).headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows the telemetry host in connect-src so the landing's Live fleet fetch is not CSP-blocked", async () => {
    // Regression guard: the marketing landing fetches the public stats endpoint client-side. With a
    // bare `connect-src 'self'` the browser blocks it and the section silently never appears.
    const csp = (await respond()).headers.get("Content-Security-Policy") ?? "";
    const connectSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src"));
    expect(connectSrc).toBeDefined();
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("https://telemetry.techskills.academy");
  });

  it("marks API responses no-store but leaves page responses cacheable", async () => {
    expect((await respond("/api/health")).headers.get("Cache-Control")).toContain("no-store");
    expect((await respond("/")).headers.get("Cache-Control")).toBeNull();
  });
});
