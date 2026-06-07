import { describe, it, expect, vi } from "vitest";

// getClientIp is pure; stub the module's side imports so it loads without a DB/env.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: { TRUSTED_PROXY: "" } }));

import { getClientIp } from "./rate-limit";

const req = (headers: Record<string, string>) => new Request("http://x", { headers });

describe("getClientIp", () => {
  it("trusts no forwarding header without a configured proxy (un-bypassable shared bucket)", () => {
    const r = req({
      "cf-connecting-ip": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1, 5.5.5.5",
      "x-real-ip": "5.5.5.5",
    });
    expect(getClientIp(r, "")).toBe("unknown");
  });

  it("uses X-Real-IP when a reverse proxy is configured", () => {
    const r = req({ "x-real-ip": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 5.5.5.5" });
    expect(getClientIp(r, "proxy")).toBe("5.5.5.5");
  });

  it("falls back to the rightmost X-Forwarded-For hop behind a proxy", () => {
    const r = req({ "x-forwarded-for": "1.1.1.1, 5.5.5.5" });
    expect(getClientIp(r, "proxy")).toBe("5.5.5.5");
  });

  it("uses CF-Connecting-IP only when configured behind Cloudflare", () => {
    const r = req({ "cf-connecting-ip": "9.9.9.9", "x-real-ip": "5.5.5.5" });
    expect(getClientIp(r, "cloudflare")).toBe("9.9.9.9");
  });

  it("does not fall back to X-Real-IP in Cloudflare mode when CF-Connecting-IP is absent", () => {
    const r = req({ "x-real-ip": "5.5.5.5" });
    expect(getClientIp(r, "cloudflare")).toBe("unknown");
  });

  it("returns 'unknown' when no usable header is present", () => {
    expect(getClientIp(req({}), "proxy")).toBe("unknown");
  });
});
