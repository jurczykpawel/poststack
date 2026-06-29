import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";

vi.mock("@/lib/env", () => ({ env: { APP_URL: "http://localhost:3000" } }));

const mockAuthenticate = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticate: (...a: unknown[]) => mockAuthenticate(...a) }));

vi.mock("@/lib/oauth/state", () => ({
  generateOAuthState: () => ({ state: "STATE123", setCookie: "rs_oauth_state=STATE123; HttpOnly; Path=/" }),
}));

// Configurable per-test config: both INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET must be set for the
// IG-Login start to proceed (A12).
let configValues: Record<string, string> = {};
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => configValues[key] ?? "",
}));

let GET: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET } = await import("./route"));
});

describe("GET /api/oauth/instagram-login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configValues = { INSTAGRAM_APP_ID: "ig-app-id-123", INSTAGRAM_APP_SECRET: "ig-app-secret-xyz" };
    mockAuthenticate.mockResolvedValue({ workspaceId: "ws-1", userId: "u-1", authMethod: "session", scopes: [] });
  });

  it("302-redirects to the Instagram Business Login authorize URL with client_id, scopes, and state", async () => {
    const res = await GET(new Request("http://localhost:3000/api/oauth/instagram-login"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    expect(loc.searchParams.get("client_id")).toBe("ig-app-id-123");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("state")).toBe("STATE123");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/oauth/instagram-login/callback");
    expect(loc.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_content_publish",
    );
    expect(res.headers.get("set-cookie")).toContain("rs_oauth_state=STATE123");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://localhost:3000/api/oauth/instagram-login"));
    expect(res.status).toBe(401);
  });

  // A12: guard the start when IG-Login isn't configured — never proceed into a broken OAuth.
  it("302-redirects to /channels?error=instagram_login_not_configured when INSTAGRAM_APP_ID is unset", async () => {
    configValues = { INSTAGRAM_APP_SECRET: "ig-app-secret-xyz" }; // app id missing
    const res = await GET(new Request("http://localhost:3000/api/oauth/instagram-login"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, "http://localhost:3000");
    expect(loc.pathname).toBe("/channels");
    expect(loc.searchParams.get("error")).toBe("instagram_login_not_configured");
    // It must NOT have built the IG authorize URL.
    expect(res.headers.get("location")).not.toContain("instagram.com/oauth/authorize");
  });

  it("302-redirects to the not-configured error when INSTAGRAM_APP_SECRET is unset", async () => {
    configValues = { INSTAGRAM_APP_ID: "ig-app-id-123" }; // secret missing
    const res = await GET(new Request("http://localhost:3000/api/oauth/instagram-login"));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!, "http://localhost:3000");
    expect(loc.pathname).toBe("/channels");
    expect(loc.searchParams.get("error")).toBe("instagram_login_not_configured");
  });
});
