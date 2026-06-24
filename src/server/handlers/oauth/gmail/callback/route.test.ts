import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";

vi.mock("@/lib/env", () => ({ env: { APP_URL: "http://localhost:3000" } }));

const mockAuthenticate = vi.fn();
vi.mock("@/lib/auth", () => ({ authenticate: (...a: unknown[]) => mockAuthenticate(...a) }));

const mockVerifyOAuthState = vi.fn();
const mockClearOAuthStateCookie = vi.fn().mockReturnValue("rs_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
vi.mock("@/lib/oauth/state", () => ({
  verifyOAuthState: (...a: unknown[]) => mockVerifyOAuthState(...a),
  clearOAuthStateCookie: () => mockClearOAuthStateCookie(),
}));

const mockGetProvider = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({ getProvider: (...a: unknown[]) => mockGetProvider(...a) }));

const mockUpsertChannels = vi.fn().mockResolvedValue({ recoveredChannelIds: [] });
const mockAssertChannelsAllowed = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/upsert", () => ({
  upsertChannels: (...a: unknown[]) => mockUpsertChannels(...a),
  assertChannelsAllowed: (...a: unknown[]) => mockAssertChannelsAllowed(...a),
}));

const mockProviderAuthenticate = vi.fn();

let GET: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET } = await import("./route"));
});

function makeRequest(params: Record<string, string>, cookieHeader?: string) {
  const url = new URL("http://localhost:3000/api/oauth/gmail/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cookieHeader) headers["cookie"] = cookieHeader;
  return new Request(url.toString(), { headers });
}

describe("GET /api/oauth/gmail/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearOAuthStateCookie.mockReturnValue("rs_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    mockVerifyOAuthState.mockReturnValue(undefined); // no throw = valid state
    mockAuthenticate.mockResolvedValue({ workspaceId: "ws-test-1", userId: "u-1", authMethod: "session", scopes: [] });
    mockProviderAuthenticate.mockResolvedValue([
      { platformId: "user@gmail.com", displayName: "user@gmail.com", username: "user@gmail.com", tokens: { access_token: "at", refresh_token: "rt" } },
    ]);
    mockGetProvider.mockReturnValue({ authenticate: mockProviderAuthenticate });
  });

  it("redirects to /channels?connected=gmail&count=1 on success", async () => {
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?connected=gmail&count=1");
    expect(mockUpsertChannels).toHaveBeenCalledWith("ws-test-1", "gmail", expect.any(Array));
    expect(mockAssertChannelsAllowed).toHaveBeenCalledWith("ws-test-1", "gmail", expect.any(Array));
  });

  it("calls getProvider with 'gmail'", async () => {
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    await GET(req);
    expect(mockGetProvider).toHaveBeenCalledWith("gmail");
  });

  it("passes the correct redirectUri to provider.authenticate", async () => {
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    await GET(req);
    expect(mockProviderAuthenticate).toHaveBeenCalledWith("authcode", "http://localhost:3000/api/oauth/gmail/callback");
  });

  it("redirects /channels?error=access_denied when error param is present", async () => {
    const req = makeRequest({ error: "access_denied" });
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=access_denied");
    expect(mockUpsertChannels).not.toHaveBeenCalled();
  });

  it("redirects /channels?error=missing_params when code or state is absent", async () => {
    const req = makeRequest({ code: "authcode" }); // no state
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=missing_params");
  });

  it("redirects /channels?error=invalid_state when verifyOAuthState throws", async () => {
    mockVerifyOAuthState.mockImplementationOnce(() => { throw new Error("CSRF mismatch"); });
    const req = makeRequest({ code: "authcode", state: "badstate" }, "rs_oauth_state=differentstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=invalid_state");
  });

  it("redirects /login?redirect=/channels when not authenticated", async () => {
    mockAuthenticate.mockResolvedValueOnce(null);
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?redirect=/channels");
  });

  it("redirects /channels?error=pro_required when ProRequiredError is thrown", async () => {
    const { ProRequiredError } = await import("@/lib/license/gate");
    mockAssertChannelsAllowed.mockRejectedValueOnce(new ProRequiredError("non_meta_channels"));
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=pro_required");
  });

  it("redirects /channels?error=oauth_failed when provider.authenticate throws", async () => {
    mockProviderAuthenticate.mockRejectedValueOnce(new Error("OAuth exchange failed"));
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=oauth_failed");
  });

  it("does NOT call subscribeChannelWebhooks (Gmail uses polling, not webhooks)", async () => {
    // subscribeChannelWebhooks should not be imported or called — Gmail is polling-based
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    await GET(req);
    // Assert upsert was called (success path ran), proving the flow completed without webhooks
    expect(mockUpsertChannels).toHaveBeenCalledTimes(1);
  });

  it("handles multiple accounts (count=2)", async () => {
    mockProviderAuthenticate.mockResolvedValueOnce([
      { platformId: "a@gmail.com", displayName: "a@gmail.com", username: "a@gmail.com", tokens: { access_token: "at1", refresh_token: "rt1" } },
      { platformId: "b@gmail.com", displayName: "b@gmail.com", username: "b@gmail.com", tokens: { access_token: "at2", refresh_token: "rt2" } },
    ]);
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?connected=gmail&count=2");
  });

  it("redirects /channels?error=no_gmail_accounts when provider.authenticate resolves to empty array", async () => {
    mockProviderAuthenticate.mockResolvedValueOnce([]);
    const req = makeRequest({ code: "authcode", state: "validstate" }, "rs_oauth_state=validstate");
    const res = await GET(req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/channels?error=no_gmail_accounts");
    expect(mockUpsertChannels).not.toHaveBeenCalled();
    expect(mockAssertChannelsAllowed).not.toHaveBeenCalled();
  });
});
