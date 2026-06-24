import { describe, it, expect, beforeAll } from "vitest";

let mod: typeof import("./google-oauth");

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  mod = await import("./google-oauth");
});

describe("buildGoogleAuthUrl", () => {
  it("requests offline access + consent + given scopes", () => {
    const url = mod.buildGoogleAuthUrl(
      { clientId: "cid", clientSecret: "sec" },
      "https://app/api/oauth/gmail/callback",
      "state123",
      ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    );
    expect(url).toContain("access_type=offline");
    expect(url).toContain("prompt=consent");
    expect(url).toContain("client_id=cid");
    expect(url).toContain(encodeURIComponent("gmail.readonly"));
    expect(url).toContain("state=state123");
  });
});

describe("exchangeGoogleCode", () => {
  it("returns expires_at in UNIX SECONDS, not milliseconds", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const nowSec = Math.floor(Date.now() / 1000);
    const tokens = await mod.exchangeGoogleCode("code", "https://app/cb", { clientId: "c", clientSecret: "s" }, fakeFetch);
    expect(tokens.access_token).toBe("at");
    expect(tokens.refresh_token).toBe("rt");
    // seconds → ~1.7e9, not ms (~1.7e12). Within an hour of now + 3600s.
    expect(tokens.expires_at).toBeGreaterThanOrEqual(nowSec + 3600 - 5);
    expect(tokens.expires_at).toBeLessThanOrEqual(nowSec + 3600 + 5);
    expect(tokens.expires_at).toBeLessThan(1e12);
  });
});
