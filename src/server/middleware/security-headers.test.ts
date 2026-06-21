import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders, buildContentSecurityPolicy } from "./security-headers";

/** Pull the tokens of one CSP directive (e.g. "connect-src") out of a full policy string. */
function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.slice(name.length + 1).split(/\s+/) : [];
}

describe("buildContentSecurityPolicy — app (default, tight)", () => {
  it("connect-src is self only; no telemetry/analytics hosts leak into the app policy", () => {
    const connect = directive(buildContentSecurityPolicy(), "connect-src");
    expect(connect).toEqual(["'self'"]);
    expect(connect).not.toContain("https://telemetry.techskills.academy");
    expect(connect).not.toContain("https://stats.techskills.academy");
    expect(connect).not.toContain("https://www.googletagmanager.com");
  });

  it("font-src is self only (no data:) and script-src has no analytics hosts", () => {
    const csp = buildContentSecurityPolicy({ landing: false });
    expect(directive(csp, "font-src")).toEqual(["'self'"]);
    expect(directive(csp, "script-src")).not.toContain("https://stats.techskills.academy");
    expect(directive(csp, "script-src")).not.toContain("https://www.googletagmanager.com");
    // altcha CDN stays — the app uses it on its own forms.
    expect(directive(csp, "script-src")).toContain("https://cdn.jsdelivr.net");
  });

  it("analytics env is ignored when landing is false (scoping guard)", () => {
    const csp = buildContentSecurityPolicy({ landing: false, analytics: { umamiWebsiteId: "x", gtmId: "y" } });
    expect(directive(csp, "connect-src")).toEqual(["'self'"]);
    expect(directive(csp, "font-src")).toEqual(["'self'"]);
  });
});

describe("buildContentSecurityPolicy — landing (relaxed)", () => {
  it("allows the telemetry endpoint and data: fonts (regression guards for the Live fleet + webfonts)", () => {
    const csp = buildContentSecurityPolicy({ landing: true });
    expect(directive(csp, "connect-src")).toContain("https://telemetry.techskills.academy");
    expect(directive(csp, "font-src")).toContain("data:");
  });

  it("allows the Umami host (and a custom one via LANDING_UMAMI_SRC) when configured", () => {
    const a = buildContentSecurityPolicy({ landing: true, analytics: { umamiWebsiteId: "abc" } });
    expect(directive(a, "script-src")).toContain("https://stats.techskills.academy");
    expect(directive(a, "connect-src")).toContain("https://stats.techskills.academy");

    const b = buildContentSecurityPolicy({
      landing: true,
      analytics: { umamiWebsiteId: "abc", umamiSrc: "https://analytics.example.com/u.js" },
    });
    expect(directive(b, "script-src")).toContain("https://analytics.example.com");
    expect(directive(b, "script-src")).not.toContain("https://stats.techskills.academy");
  });

  it("allows GTM script + collect hosts when configured", () => {
    const csp = buildContentSecurityPolicy({ landing: true, analytics: { gtmId: "GTM-XXXX" } });
    expect(directive(csp, "script-src")).toContain("https://www.googletagmanager.com");
    const connect = directive(csp, "connect-src");
    expect(connect).toContain("https://www.googletagmanager.com");
    expect(connect).toContain("https://www.google-analytics.com");
    expect(connect).toContain("https://t.poststack.techskills.academy");
  });

  it("does not add analytics hosts when nothing is configured (only telemetry + data: fonts)", () => {
    const csp = buildContentSecurityPolicy({ landing: true });
    expect(directive(csp, "script-src")).not.toContain("https://stats.techskills.academy");
    expect(directive(csp, "script-src")).not.toContain("https://www.googletagmanager.com");
  });

  it("keeps default-src and frame-ancestors locked down in both modes", () => {
    for (const landing of [true, false]) {
      const csp = buildContentSecurityPolicy({ landing });
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    }
  });
});

/** Build a minimal app with the middleware mounted, and return the response for `path`. */
async function respond(path: string) {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/", (c) => c.text("ok"));
  app.get("/privacy", (c) => c.text("ok"));
  app.get("/overview", (c) => c.text("ok"));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/_astro/app.js", (c) => c.text("js"));
  return app.request(path);
}

describe("securityHeaders middleware — per-path CSP", () => {
  it("sets the core hardening headers everywhere", async () => {
    const res = await respond("/");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("landing documents (/ and /privacy) get the relaxed CSP", async () => {
    for (const p of ["/", "/privacy"]) {
      const csp = (await respond(p)).headers.get("Content-Security-Policy") ?? "";
      expect(directive(csp, "connect-src")).toContain("https://telemetry.techskills.academy");
      expect(directive(csp, "font-src")).toContain("data:");
    }
  });

  it("the dashboard, API and assets keep the tight app CSP (no telemetry / data: fonts)", async () => {
    for (const p of ["/overview", "/api/health", "/_astro/app.js"]) {
      const csp = (await respond(p)).headers.get("Content-Security-Policy") ?? "";
      expect(directive(csp, "connect-src")).toEqual(["'self'"]);
      expect(directive(csp, "font-src")).toEqual(["'self'"]);
    }
  });

  it("marks API responses no-store but leaves page responses cacheable", async () => {
    expect((await respond("/api/health")).headers.get("Cache-Control")).toContain("no-store");
    expect((await respond("/")).headers.get("Cache-Control")).toBeNull();
  });
});
