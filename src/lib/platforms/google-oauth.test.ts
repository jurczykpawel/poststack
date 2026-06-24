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
