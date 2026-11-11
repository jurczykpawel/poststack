import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import type { SessionAuthContext } from "@/lib/auth";

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
const SESSION: SessionAuthContext = {
  userId: "user-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  authMethod: "session",
  scopes: [],
};

beforeAll(async () => {
  ({ startPublishOAuth } = await import("./connect"));
});

describe("startPublishOAuth — generic across providers", () => {
  it("builds a TikTok authorize URL with a state cookie (no PKCE)", async () => {
    const { url, cookies } = await startPublishOAuth("tiktok", "https://app/cb", SESSION);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(u.searchParams.get("client_key")).toBe("tt-key");
    expect(u.searchParams.get("scope")).toBe("user.info.basic,video.upload,video.publish");
    expect(cookies.some((c) => c.startsWith("rs_oauth_state="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("rs_oauth_pkce="))).toBe(false);
  });

  it("adds a PKCE challenge + verifier cookie for X (Twitter)", async () => {
    const { url, cookies } = await startPublishOAuth("twitter", "https://app/cb", SESSION);
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookies.some((c) => c.startsWith("rs_oauth_pkce="))).toBe(true);
  });

  it("throws for a platform without OAuth credentials configured", async () => {
    await expect(startPublishOAuth("linkedin", "https://app/cb", SESSION)).rejects.toThrow(/not configured for OAuth/);
  });
});

describe("startPublishOAuth — connect pages variant", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("LinkedIn adds the page scopes and marks the state; the plain connect keeps member scopes", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "li-id");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "li-secret");
    const plain = new URL((await startPublishOAuth("linkedin", "https://app/cb", SESSION)).url);
    expect(plain.searchParams.get("scope")).toBe("openid profile w_member_social");
    const pages = await startPublishOAuth("linkedin", "https://app/cb", SESSION, { subAccounts: true });
    expect(new URL(pages.url).searchParams.get("scope")).toBe("openid profile w_member_social w_organization_social r_organization_admin");
    const context = pages.cookies[0]!.split(";")[0]!.split(".")[1]!;
    expect(JSON.parse(Buffer.from(context, "base64url").toString()).purpose).toEqual({ kind: "connect", subAccounts: true });
  });

  it("refuses the variant for a provider without pages", async () => {
    await expect(startPublishOAuth("tiktok", "https://app/cb", SESSION, { subAccounts: true })).rejects.toThrow(/no pages/);
  });
});
