import { and, eq, isNull, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { getProviderForPlatform, platformForConnectId } from "@/lib/providers";
import { fromTokenSet } from "@/lib/providers/token-codec";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { buildAuthorizeUrl, createPkcePair } from "./authorize";
import { exchangeCodeForToken } from "./exchange";
import { pickCookie } from "./pick";
import type { SessionAuthContext } from "@/lib/auth";
import {
  connectOAuthFlow,
  generateOAuthState,
  verifyOAuthState,
  clearOAuthStateCookie,
  pkceCookie,
  readPkceCookie,
  clearPkceCookie,
} from "./state";

/**
 * Generic publish-side OAuth connect (CHANNELS-ARCHITECTURE: `oauth` credential-acquisition strategy).
 * One flow drives EVERY publish provider that exposes an `oauthConfig()` — TikTok, X, LinkedIn,
 * Threads, YouTube — so adding a provider needs no new connect code. Meta keeps its own page/IG +
 * managed-connection flow (different shape). State + PKCE travel in short-lived HttpOnly cookies.
 */

async function configFor(platform: string) {
  const provider = getProviderForPlatform(platform);
  const config = await provider.oauthConfig?.();
  if (!config) throw new Error(`${platform} is not configured for OAuth connect (missing client credentials)`);
  return { provider, config };
}

/** Begin connect: the authorize URL to redirect to + the Set-Cookie headers (state, and PKCE for X).
 *  `subAccounts` = the opt-in "connect pages" variant: adds the provider's sub-account scopes and makes
 *  the callback hand over to the page picker instead of connecting the member account. */
export async function startPublishOAuth(
  platform: string,
  redirectUri: string,
  auth: SessionAuthContext,
  opts: { subAccounts?: boolean } = {},
): Promise<{ url: string; cookies: string[] }> {
  const { provider, config } = await configFor(platform);
  if (opts.subAccounts && !(config.subAccountScopes && provider.enumerateSubAccounts)) {
    throw new Error(`${platform} has no pages to connect`);
  }
  const purpose = opts.subAccounts ? { kind: "connect" as const, subAccounts: true as const } : undefined;
  const { state, setCookie } = generateOAuthState(auth, connectOAuthFlow(platform), purpose);
  const cookies = [setCookie];
  let codeChallenge: string | undefined;
  if (config.usePkce) {
    const { verifier, challenge } = createPkcePair();
    codeChallenge = challenge;
    cookies.push(pkceCookie(verifier));
  }
  const scopes = opts.subAccounts ? [...config.scopes, ...config.subAccountScopes!] : config.scopes;
  return { url: buildAuthorizeUrl({ ...config, scopes }, { state, redirectUri, codeChallenge }), cookies };
}

// A cutover-seeded channel keyed by a vanity handle (not the provider's API id) can't publish and
// gets flagged `needs_reauth` (SEEDCH1). Reconnecting mints a NEW row keyed by the real id, leaving
// the handle row orphaned. Since a handle is unique per platform, an exact match of the freshly
// resolved account's handle to a needs_reauth row's stored handle proves it's the same account — so
// soft-delete it. Scoped to needs_reauth rows only: a live channel is never touched.
const normHandle = (s: string) => s.trim().toLowerCase().replace(/^@/, "");
export async function softDeleteReauthOrphans(
  workspaceId: string,
  platform: Platform,
  handle: string | undefined,
  keepId: string,
): Promise<number> {
  if (!handle) return 0;
  const target = normHandle(handle);
  if (!target) return 0;
  const siblings = await db.query.channels.findMany({
    where: and(
      eq(channels.workspace_id, workspaceId),
      eq(channels.platform, platform),
      eq(channels.status, "needs_reauth"),
      isNull(channels.deleted_at),
      ne(channels.id, keepId),
    ),
    columns: { id: true, platform_id: true, username: true },
  });
  const ids = siblings
    .filter(
      (s) =>
        normHandle(String(s.platform_id)) === target ||
        (s.username != null && normHandle(s.username) === target),
    )
    .map((s) => s.id);
  if (ids.length === 0) return 0;
  await db.update(channels).set({ deleted_at: new Date(), updated_at: new Date() }).where(inArray(channels.id, ids));
  return ids.length;
}

type CallbackArgs = {
  platform: string;
  code: string;
  state: string;
  cookieHeader: string | null;
  redirectUri: string;
  auth: SessionAuthContext;
};

/** Callback leg shared by both variants: verify CSRF state (+ PKCE), exchange the code. */
async function exchangeVerified(args: CallbackArgs) {
  const { provider, config } = await configFor(args.platform);
  const purpose = verifyOAuthState(args.state, args.cookieHeader, args.auth, connectOAuthFlow(args.platform));
  let codeVerifier: string | undefined;
  if (config.usePkce) {
    codeVerifier = readPkceCookie(args.cookieHeader) ?? undefined;
    if (!codeVerifier) throw new Error("Missing PKCE verifier — restart the connection");
  }
  let tokens = await exchangeCodeForToken(config, { code: args.code, redirectUri: args.redirectUri, codeVerifier });
  if (provider.exchangeLongLived) tokens = await provider.exchangeLongLived(tokens);
  return { provider, tokens, subAccounts: purpose.kind === "connect" && purpose.subAccounts === true };
}

/** Finish the "connect pages" variant: park the token for the picker (`/channels/pick/:platform`). */
export async function beginSubAccountPick(args: CallbackArgs): Promise<{ cookies: string[] }> {
  const { tokens, subAccounts } = await exchangeVerified(args);
  if (!subAccounts) throw new Error("Invalid OAuth state");
  return { cookies: [pickCookie(args.platform, tokens, args.auth), clearOAuthStateCookie(), clearPkceCookie()] };
}

/**
 * Finish connect on the callback: verify CSRF state, exchange the code, resolve the account via the
 * provider's healthCheck, and upsert an `oauth` channel (through the single channel-creation path, so
 * the one-account-one-workspace invariant holds). Returns the channel id + cookies to clear.
 */
export async function completePublishOAuth(args: CallbackArgs): Promise<{ channelId: string; accountId: string; clearCookies: string[] }> {
  const { workspaceId } = args.auth;
  const { provider, tokens, subAccounts } = await exchangeVerified(args);
  if (subAccounts) throw new Error("Invalid OAuth state");
  const info = await provider.healthCheck(tokens); // resolves accountId + display/handle/avatar

  const account: ConnectedAccount = {
    platformId: info.accountId,
    displayName: info.displayName ?? info.handle ?? args.platform,
    username: info.handle,
    profilePicture: info.avatarUrl,
    tokens: fromTokenSet(tokens),
  };
  // The connect URL is keyed by provider id (/connect/x); the channel's platform column is the RS
  // value (twitter). Map so /connect/x stores platform "twitter", not the invalid enum "x".
  const platform = platformForConnectId(args.platform) as Platform;
  // License gate: a non-Meta channel needs `non_meta_channels` (throws ProRequiredError → 402).
  await assertChannelsAllowed(workspaceId, platform, [account]);
  await upsertChannels(workspaceId, platform, [account], { connectionMode: "oauth" });

  const ch = await db.query.channels.findFirst({
    where: and(
      eq(channels.workspace_id, workspaceId),
      eq(channels.platform, platform),
      eq(channels.platform_id, info.accountId),
    ),
    columns: { id: true },
  });
  // Sweep any pre-migration handle-keyed orphan for this same account (SEEDCH1 self-cleanup).
  await softDeleteReauthOrphans(workspaceId, platform, info.handle, ch!.id);
  return { channelId: ch!.id, accountId: info.accountId, clearCookies: [clearOAuthStateCookie(), clearPkceCookie()] };
}
