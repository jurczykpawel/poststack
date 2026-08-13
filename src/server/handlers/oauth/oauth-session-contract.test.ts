import { beforeEach, describe, expect, it, vi } from "vitest";

const API_KEY_AUTH = {
  workspaceId: "ws-api-key",
  userId: "api-key:key-1",
  authMethod: "api_key" as const,
  scopes: [],
};

const SESSION_AUTH = {
  workspaceId: "ws-session",
  userId: "user-session",
  sessionId: "session-1",
  authMethod: "session" as const,
  scopes: [],
};

const mockAuthenticate = vi.fn();
const mockAuthenticateSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  // Deliberately return a valid API-key context from the legacy dual-auth helper. If any one
  // OAuth handler regresses to authenticate(), that handler will continue into provider work.
  authenticate: (...args: unknown[]) => mockAuthenticate(...args),
  authenticateSession: (...args: unknown[]) => mockAuthenticateSession(...args),
}));

vi.mock("@/lib/env", () => ({
  env: {
    APP_URL: "http://localhost:3000",
    CRON_SECRET: "test-cron-secret-at-least-32-characters-long",
    META_WEBHOOK_VERIFY_TOKEN: "verify-token",
    META_APP_SECRET: "app-secret",
  },
}));

const mockGenerateOAuthState = vi.fn();
const mockVerifyOAuthState = vi.fn();
const mockVerifyOAuthStateCookie = vi.fn();
const mockClearOAuthStateCookie = vi.fn();
const mockClearPkceCookie = vi.fn();
vi.mock("@/lib/oauth/state", () => ({
  OAUTH_FLOWS: {
    facebook: "facebook",
    instagram: "instagram",
    instagramLogin: "instagram-login",
    youtube: "youtube",
    gmail: "gmail",
  },
  connectOAuthFlow: (platform: string) => `connect:${platform}`,
  generateOAuthState: (...args: unknown[]) => mockGenerateOAuthState(...args),
  verifyOAuthState: (...args: unknown[]) => mockVerifyOAuthState(...args),
  verifyOAuthStateCookie: (...args: unknown[]) => mockVerifyOAuthStateCookie(...args),
  clearOAuthStateCookie: (...args: unknown[]) => mockClearOAuthStateCookie(...args),
  clearPkceCookie: (...args: unknown[]) => mockClearPkceCookie(...args),
}));

const mockProviderGenerateAuthUrl = vi.fn();
const mockProviderAuthenticate = vi.fn();
const mockGetProvider = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}));

const mockAssertChannelsAllowed = vi.fn();
const mockUpsertChannels = vi.fn();
vi.mock("@/lib/channels/upsert", () => ({
  assertChannelsAllowed: (...args: unknown[]) => mockAssertChannelsAllowed(...args),
  upsertChannels: (...args: unknown[]) => mockUpsertChannels(...args),
}));

const mockSubscribeChannelWebhooks = vi.fn();
const mockSubscribeInstagramMessaging = vi.fn();
vi.mock("@/lib/channels/subscribe", () => ({
  subscribeChannelWebhooks: (...args: unknown[]) => mockSubscribeChannelWebhooks(...args),
  subscribeInstagramMessaging: (...args: unknown[]) => mockSubscribeInstagramMessaging(...args),
}));

const mockGetConfig = vi.fn();
vi.mock("@/lib/settings/config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

const mockBuildInstagramLoginAuthUrl = vi.fn();
const mockExchangeInstagramLoginCode = vi.fn();
vi.mock("@/lib/platforms/instagram-login", () => ({
  buildInstagramLoginAuthUrl: (...args: unknown[]) => mockBuildInstagramLoginAuthUrl(...args),
  exchangeInstagramLoginCode: (...args: unknown[]) => mockExchangeInstagramLoginCode(...args),
}));

const mockGoogleAuthUrl = vi.fn();
const mockExchangeGoogleCode = vi.fn();
const mockGetMyChannel = vi.fn();
vi.mock("@/lib/youtube/client", () => ({
  googleAuthUrl: (...args: unknown[]) => mockGoogleAuthUrl(...args),
  exchangeGoogleCode: (...args: unknown[]) => mockExchangeGoogleCode(...args),
  getMyChannel: (...args: unknown[]) => mockGetMyChannel(...args),
}));

const mockStartPublishOAuth = vi.fn();
const mockCompletePublishOAuth = vi.fn();
const mockSoftDeleteReauthOrphans = vi.fn();
vi.mock("@/lib/oauth/connect", () => ({
  startPublishOAuth: (...args: unknown[]) => mockStartPublishOAuth(...args),
  completePublishOAuth: (...args: unknown[]) => mockCompletePublishOAuth(...args),
  softDeleteReauthOrphans: (...args: unknown[]) => mockSoftDeleteReauthOrphans(...args),
}));

const mockFindConnectedYouTubeChannel = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      channels: {
        findFirst: (...args: unknown[]) => mockFindConnectedYouTubeChannel(...args),
      },
    },
  },
}));

vi.mock("@/lib/license/gate", () => ({
  ProRequiredError: class ProRequiredError extends Error {},
}));

import * as facebookStart from "@/server/handlers/oauth/facebook/route";
import * as facebookCallback from "@/server/handlers/oauth/facebook/callback/route";
import * as instagramStart from "@/server/handlers/oauth/instagram/route";
import * as instagramCallback from "@/server/handlers/oauth/instagram/callback/route";
import * as instagramLoginStart from "@/server/handlers/oauth/instagram-login/route";
import * as instagramLoginCallback from "@/server/handlers/oauth/instagram-login/callback/route";
import * as youtubeStart from "@/server/handlers/oauth/youtube/route";
import * as youtubeCallback from "@/server/handlers/oauth/youtube/callback/route";
import * as gmailStart from "@/server/handlers/oauth/gmail/route";
import * as gmailCallback from "@/server/handlers/oauth/gmail/callback/route";
import * as connectStart from "@/server/handlers/oauth/connect/route";
import * as connectCallback from "@/server/handlers/oauth/connect/callback/route";
import { special } from "@/server/routes/special";

type OAuthRouteCase = {
  mountPath: string;
  requestPath: string;
  callback: boolean;
  flow: string;
  invoke: (request: Request) => Promise<Response>;
};

const cases: OAuthRouteCase[] = [
  { mountPath: "/api/oauth/facebook", requestPath: "/api/oauth/facebook", callback: false, flow: "facebook", invoke: facebookStart.GET },
  { mountPath: "/api/oauth/facebook/callback", requestPath: "/api/oauth/facebook/callback", callback: true, flow: "facebook", invoke: facebookCallback.GET },
  { mountPath: "/api/oauth/instagram", requestPath: "/api/oauth/instagram", callback: false, flow: "instagram", invoke: instagramStart.GET },
  { mountPath: "/api/oauth/instagram/callback", requestPath: "/api/oauth/instagram/callback", callback: true, flow: "instagram", invoke: instagramCallback.GET },
  { mountPath: "/api/oauth/instagram-login", requestPath: "/api/oauth/instagram-login", callback: false, flow: "instagram-login", invoke: instagramLoginStart.GET },
  { mountPath: "/api/oauth/instagram-login/callback", requestPath: "/api/oauth/instagram-login/callback", callback: true, flow: "instagram-login", invoke: instagramLoginCallback.GET },
  { mountPath: "/api/oauth/youtube", requestPath: "/api/oauth/youtube", callback: false, flow: "youtube", invoke: youtubeStart.GET },
  { mountPath: "/api/oauth/youtube/callback", requestPath: "/api/oauth/youtube/callback", callback: true, flow: "youtube", invoke: youtubeCallback.GET },
  { mountPath: "/api/oauth/gmail", requestPath: "/api/oauth/gmail", callback: false, flow: "gmail", invoke: gmailStart.GET },
  { mountPath: "/api/oauth/gmail/callback", requestPath: "/api/oauth/gmail/callback", callback: true, flow: "gmail", invoke: gmailCallback.GET },
  { mountPath: "/api/oauth/connect/:platform", requestPath: "/api/oauth/connect/tiktok", callback: false, flow: "connect:tiktok", invoke: (request) => connectStart.GET(request, "tiktok") },
  { mountPath: "/api/oauth/connect/:platform/callback", requestPath: "/api/oauth/connect/tiktok/callback", callback: true, flow: "connect:tiktok", invoke: (request) => connectCallback.GET(request, "tiktok") },
];

const downstreamEffects = [
  ["generate OAuth state", mockGenerateOAuthState],
  ["resolve provider", mockGetProvider],
  ["generate provider authorization URL", mockProviderGenerateAuthUrl],
  ["exchange provider authorization code", mockProviderAuthenticate],
  ["read provider configuration", mockGetConfig],
  ["build Instagram Login authorization URL", mockBuildInstagramLoginAuthUrl],
  ["exchange Instagram Login code", mockExchangeInstagramLoginCode],
  ["build YouTube authorization URL", mockGoogleAuthUrl],
  ["exchange YouTube authorization code", mockExchangeGoogleCode],
  ["resolve YouTube channel", mockGetMyChannel],
  ["check channel allowance", mockAssertChannelsAllowed],
  ["upsert channels", mockUpsertChannels],
  ["subscribe channel webhooks", mockSubscribeChannelWebhooks],
  ["subscribe Instagram messaging", mockSubscribeInstagramMessaging],
  ["start generic publish OAuth", mockStartPublishOAuth],
  ["complete generic publish OAuth", mockCompletePublishOAuth],
  ["query connected YouTube channel", mockFindConnectedYouTubeChannel],
  ["delete YouTube reauth orphans", mockSoftDeleteReauthOrphans],
] as const;

function apiKeyRequest(route: OAuthRouteCase): Request {
  const url = new URL(route.requestPath, "http://localhost:3000");
  if (route.callback) {
    url.searchParams.set("code", "oauth-code");
    url.searchParams.set("state", "valid-state");
  }
  return new Request(url, {
    headers: {
      authorization: "Bearer sk_live_oauth_contract_key",
      cookie: "rs_oauth_state=valid-state; rs_oauth_pkce=valid-verifier",
    },
  });
}

function sessionRequest(route: OAuthRouteCase): Request {
  const url = new URL(route.requestPath, "http://localhost:3000");
  if (route.callback) {
    url.searchParams.set("code", "oauth-code");
    url.searchParams.set("state", "valid-state");
  }
  return new Request(url, {
    headers: { cookie: "session=valid-session; rs_oauth_state=valid-state.signed" },
  });
}

describe("interactive OAuth session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    mockAuthenticate.mockResolvedValue(API_KEY_AUTH);
    mockAuthenticateSession.mockResolvedValue(null);
    mockGenerateOAuthState.mockReturnValue({
      state: "generated-state",
      setCookie: "rs_oauth_state=generated-state; HttpOnly; Path=/",
    });
    mockVerifyOAuthState.mockReturnValue(undefined);
    mockVerifyOAuthStateCookie.mockReturnValue(undefined);
    mockClearOAuthStateCookie.mockReturnValue("rs_oauth_state=; HttpOnly; Path=/; Max-Age=0");
    mockClearPkceCookie.mockReturnValue("rs_oauth_pkce=; HttpOnly; Path=/; Max-Age=0");
    mockProviderGenerateAuthUrl.mockResolvedValue("https://provider.example/authorize");
    mockProviderAuthenticate.mockResolvedValue([
      {
        platformId: "account-1",
        displayName: "Account One",
        tokens: { access_token: "access-token", refresh_token: "refresh-token" },
      },
    ]);
    mockGetProvider.mockReturnValue({
      generateAuthUrl: mockProviderGenerateAuthUrl,
      authenticate: mockProviderAuthenticate,
    });
    mockAssertChannelsAllowed.mockResolvedValue(undefined);
    mockUpsertChannels.mockResolvedValue({ recoveredChannelIds: [] });
    mockSubscribeChannelWebhooks.mockResolvedValue(undefined);
    mockSubscribeInstagramMessaging.mockResolvedValue({ ok: true });
    mockGetConfig.mockImplementation(async (key: string) => `${key.toLowerCase()}-value`);
    mockBuildInstagramLoginAuthUrl.mockResolvedValue("https://instagram.example/authorize");
    mockExchangeInstagramLoginCode.mockResolvedValue({
      igUserId: "ig-account-1",
      username: "ig-account",
      messagingToken: "ig-token",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    mockGoogleAuthUrl.mockReturnValue("https://google.example/authorize");
    mockExchangeGoogleCode.mockResolvedValue({
      accessToken: "youtube-access",
      refreshToken: "youtube-refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    mockGetMyChannel.mockResolvedValue({
      id: "youtube-channel-1",
      title: "YouTube channel",
      handle: "youtubehandle",
    });
    mockStartPublishOAuth.mockReturnValue({
      url: "https://publish-provider.example/authorize",
      cookies: ["rs_oauth_state=generated-state; HttpOnly; Path=/"],
    });
    mockCompletePublishOAuth.mockResolvedValue({
      accountId: "account-1",
      channelId: "channel-1",
      clearCookies: ["rs_oauth_state=; HttpOnly; Path=/; Max-Age=0"],
    });
    mockFindConnectedYouTubeChannel.mockResolvedValue(undefined);
    mockSoftDeleteReauthOrphans.mockResolvedValue(undefined);
  });

  it("covers every mounted interactive OAuth route", () => {
    const mounted = special.routes
      .filter((route) => route.method === "GET" && route.path.startsWith("/api/oauth/"))
      .map((route) => route.path)
      .sort();
    const covered = cases.map((route) => route.mountPath).sort();

    expect(covered).toEqual(mounted);
  });

  it.each(cases)("GET $mountPath rejects an API key before starting OAuth work", async (route) => {
    const request = apiKeyRequest(route);
    const response = await route.invoke(request);

    expect(mockAuthenticateSession).toHaveBeenCalledOnce();
    expect(mockAuthenticateSession).toHaveBeenCalledWith(request);
    expect(mockAuthenticate).not.toHaveBeenCalled();

    if (route.callback) {
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("http://localhost:3000/login?redirect=/channels");
    } else {
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    }

    const calledEffects = downstreamEffects
      .filter(([, effect]) => effect.mock.calls.length > 0)
      .map(([name]) => name);
    expect(calledEffects).toEqual([]);
  });

  it.each(cases)("GET $mountPath accepts the interactive session contract", async (route) => {
    mockAuthenticateSession.mockResolvedValue(SESSION_AUTH);
    const request = sessionRequest(route);
    const response = await route.invoke(request);

    expect(response.status).toBe(302);
    expect(mockAuthenticateSession).toHaveBeenCalledWith(request);
    expect(mockAuthenticate).not.toHaveBeenCalled();

    if (route.callback) {
      expect(mockVerifyOAuthStateCookie).toHaveBeenCalledWith(
        "valid-state",
        request.headers.get("cookie"),
      );
      expect(mockVerifyOAuthState).toHaveBeenCalledWith(
        "valid-state",
        request.headers.get("cookie"),
        SESSION_AUTH,
        route.flow,
      );
    } else if (route.mountPath === "/api/oauth/connect/:platform") {
      expect(mockStartPublishOAuth).toHaveBeenCalledWith(
        "tiktok",
        "http://localhost:3000/api/oauth/connect/tiktok/callback",
        SESSION_AUTH,
      );
    } else {
      expect(mockGenerateOAuthState).toHaveBeenCalledWith(SESSION_AUTH, route.flow);
    }
  });
});
