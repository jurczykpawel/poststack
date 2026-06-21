import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders, buildContentSecurityPolicy } from "./security-headers";

/** Pull the tokens of one CSP directive (e.g. "connect-src") out of a full policy string. */
function directive(csp: string, name: string): string[] {
  const d = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.slice(name.length + 1).split(/\s+/) : [];
}

describe("buildContentSecurityPolicy", () => {
  it("with no analytics: connect-src is self + the public telemetry endpoint only", () => {
    const connect = directive(buildContentSecurityPolicy(), "connect-src");
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://telemetry.techskills.academy");
    // No analytics hosts leak in when nothing is configured.
    expect(connect).not.toContain("https://stats.techskills.academy");
    expect(connect).not.toContain("https://www.googletagmanager.com");
  });

  it("telemetry host is what lets the landing's Live fleet fetch succeed (regression guard)", () => {
    // The fleet section fetches the public stats endpoint client-side; without this it is CSP-blocked
    // and the section silently never appears.
    expect(directive(buildContentSecurityPolicy(), "connect-src")).toContain(
      "https://telemetry.techskills.academy",
    );
  });

  it("with Umami configured: its host is allowed in script-src and connect-src", () => {
    const csp = buildContentSecurityPolicy({ umamiWebsiteId: "abc-123" });
    expect(directive(csp, "script-src")).toContain("https://stats.techskills.academy");
    expect(directive(csp, "connect-src")).toContain("https://stats.techskills.academy");
  });

  it("honours a custom Umami host (LANDING_UMAMI_SRC) by its origin", () => {
    const csp = buildContentSecurityPolicy({
      umamiWebsiteId: "abc-123",
      umamiSrc: "https://analytics.example.com/u.js",
    });
    expect(directive(csp, "script-src")).toContain("https://analytics.example.com");
    expect(directive(csp, "connect-src")).toContain("https://analytics.example.com");
    expect(directive(csp, "script-src")).not.toContain("https://stats.techskills.academy");
  });

  it("with GTM configured: googletagmanager (script) and the collect hosts (connect) are allowed", () => {
    const csp = buildContentSecurityPolicy({ gtmId: "GTM-XXXX" });
    expect(directive(csp, "script-src")).toContain("https://www.googletagmanager.com");
    const connect = directive(csp, "connect-src");
    expect(connect).toContain("https://www.googletagmanager.com");
    expect(connect).toContain("https://www.google-analytics.com");
    expect(connect).toContain("https://t.poststack.techskills.academy");
  });

  it("ignores blank/whitespace env values", () => {
    const csp = buildContentSecurityPolicy({ umamiWebsiteId: "   ", gtmId: "" });
    expect(directive(csp, "script-src")).not.toContain("https://stats.techskills.academy");
    expect(directive(csp, "script-src")).not.toContain("https://www.googletagmanager.com");
  });

  it("keeps default-src and frame-ancestors locked down", () => {
    const csp = buildContentSecurityPolicy({ umamiWebsiteId: "x", gtmId: "y" });
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows data: fonts (the landing inlines its webfonts as base64) — regression guard", () => {
    // Without this the browser blocks the inlined @fontsource woff2 and falls back to system fonts.
    expect(directive(buildContentSecurityPolicy(), "font-src")).toContain("data:");
  });
});

/** Build a minimal app with the middleware mounted, and return the response for `path`. */
async function respond(path = "/") {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/", (c) => c.text("ok"));
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  return app.request(path);
}

describe("securityHeaders middleware", () => {
  it("sets the core hardening headers and a CSP", async () => {
    const res = await respond();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("marks API responses no-store but leaves page responses cacheable", async () => {
    expect((await respond("/api/health")).headers.get("Cache-Control")).toContain("no-store");
    expect((await respond("/")).headers.get("Cache-Control")).toBeNull();
  });
});
