import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
// publish-OAuth provider credentials so oauthConfig() resolves
process.env.TIKTOK_CLIENT_KEY ??= "tt-key";
process.env.TIKTOK_CLIENT_SECRET ??= "tt-secret";
process.env.X_CLIENT_ID ??= "x-id";
process.env.X_CLIENT_SECRET ??= "x-secret";

let startPublishOAuth: typeof import("./connect").startPublishOAuth;

beforeAll(async () => {
  ({ startPublishOAuth } = await import("./connect"));
});

describe("startPublishOAuth — generic across providers", () => {
  it("builds a TikTok authorize URL with a state cookie (no PKCE)", () => {
    const { url, cookies } = startPublishOAuth("tiktok", "https://app/cb");
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(u.searchParams.get("client_key")).toBe("tt-key");
    expect(u.searchParams.get("scope")).toBe("user.info.basic,video.upload,video.publish");
    expect(cookies.some((c) => c.startsWith("rs_oauth_state="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("rs_oauth_pkce="))).toBe(false);
  });

  it("adds a PKCE challenge + verifier cookie for X (Twitter)", () => {
    const { url, cookies } = startPublishOAuth("twitter", "https://app/cb");
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookies.some((c) => c.startsWith("rs_oauth_pkce="))).toBe(true);
  });

  it("throws for a platform without OAuth credentials configured", () => {
    expect(() => startPublishOAuth("linkedin", "https://app/cb")).toThrow(/not configured for OAuth/);
  });
});
