import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";

vi.mock("@/lib/env", () => ({ env: { APP_URL: "http://localhost:3000" } }));

const mockAuthenticate = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticate: (...a: unknown[]) => mockAuthenticate(...a) }));

const mockVerifyOAuthState = vi.fn();
vi.mock("@/lib/oauth/state", () => ({
  verifyOAuthState: (...a: unknown[]) => mockVerifyOAuthState(...a),
  clearOAuthStateCookie: () => "rs_oauth_state=; HttpOnly; Path=/; Max-Age=0",
}));

const mockUpsertChannels = vi.fn().mockResolvedValue({ recoveredChannelIds: [] });
const mockAssertChannelsAllowed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/upsert", () => ({
  upsertChannels: (...a: unknown[]) => mockUpsertChannels(...a),
  assertChannelsAllowed: (...a: unknown[]) => mockAssertChannelsAllowed(...a),
}));

const mockExchange = vi.fn();
vi.mock("@/lib/platforms/instagram-login", () => ({
  exchangeInstagramLoginCode: (...a: unknown[]) => mockExchange(...a),
}));

const mockSubscribeIgMessaging = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/channels/subscribe", () => ({
  subscribeInstagramMessaging: (...a: unknown[]) => mockSubscribeIgMessaging(...a),
}));

let GET: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET } = await import("./route"));
});

function makeRequest(params: Record<string, string>, cookieHeader?: string) {
  const url = new URL("http://localhost:3000/api/oauth/instagram-login/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cookieHeader) headers["cookie"] = cookieHeader;
  return new Request(url.toString(), { headers });
}

const EXP = new Date(Date.now() + 5184000 * 1000);

describe("GET /api/oauth/instagram-login/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyOAuthState.mockReturnValue(undefined);
    mockAuthenticate.mockResolvedValue({ workspaceId: "ws-1", userId: "u-1", authMethod: "session", scopes: [] });
    mockExchange.mockResolvedValue({
      igUserId: "17841400000",
      username: "acme_biz",
      messagingToken: "IGQW_LONG_TOK",
      expiresAt: EXP,
    });
  });

  it("augments the IG channel with the messaging token (NOT a plain token overwrite) and redirects", async () => {
    const res = await GET(makeRequest({ code: "auth_code", state: "STATE123" }, "rs_oauth_state=STATE123"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?connected=instagram_messaging");

    expect(mockExchange).toHaveBeenCalledWith("auth_code", "http://localhost:3000/api/oauth/instagram-login/callback");
    // Channel identity = the IG business id; opts carry augmentMessagingToken (FB token untouched).
    expect(mockUpsertChannels).toHaveBeenCalledWith(
      "ws-1",
      "instagram",
      [expect.objectContaining({ platformId: "17841400000", username: "acme_biz" })],
      { augmentMessagingToken: { token: "IGQW_LONG_TOK", expiresAt: EXP } },
    );
    expect(mockAssertChannelsAllowed).toHaveBeenCalledWith("ws-1", "instagram", expect.any(Array));
    // IGFU2: after the token is stored, the IG account is subscribed to messaging webhooks the
    // IG-Login-native way (per-account subscribed_apps), so an IG-Login-only channel receives DMs.
    expect(mockSubscribeIgMessaging).toHaveBeenCalledWith("ws-1", "17841400000", "IGQW_LONG_TOK");
  });

  it("redirects access_denied when error param present", async () => {
    const res = await GET(makeRequest({ error: "access_denied" }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=access_denied");
    expect(mockUpsertChannels).not.toHaveBeenCalled();
  });

  it("redirects missing_params when code or state absent", async () => {
    const res = await GET(makeRequest({ code: "auth_code" }));
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=missing_params");
  });

  it("redirects invalid_state when verifyOAuthState throws", async () => {
    mockVerifyOAuthState.mockImplementationOnce(() => { throw new Error("CSRF"); });
    const res = await GET(makeRequest({ code: "auth_code", state: "bad" }, "rs_oauth_state=other"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=invalid_state");
  });

  it("redirects to login when unauthenticated", async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const res = await GET(makeRequest({ code: "auth_code", state: "STATE123" }, "rs_oauth_state=STATE123"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?redirect=/channels");
  });

  it("redirects oauth_failed when the token exchange throws", async () => {
    mockExchange.mockRejectedValueOnce(new Error("boom"));
    const res = await GET(makeRequest({ code: "auth_code", state: "STATE123" }, "rs_oauth_state=STATE123"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=oauth_failed");
  });

  it("redirects pro_required when the channel cap is hit", async () => {
    const { ProRequiredError } = await import("@/lib/license/gate");
    mockAssertChannelsAllowed.mockRejectedValueOnce(new ProRequiredError("multi_channel"));
    const res = await GET(makeRequest({ code: "auth_code", state: "STATE123" }, "rs_oauth_state=STATE123"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=pro_required");
  });
});
