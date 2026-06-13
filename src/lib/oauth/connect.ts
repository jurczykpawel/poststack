import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { getProviderForPlatform } from "@/lib/providers";
import { fromTokenSet } from "@/lib/providers/token-codec";
import { upsertChannels, assertChannelsAllowed } from "@/lib/channels/upsert";
import { buildAuthorizeUrl, createPkcePair } from "./authorize";
import { exchangeCodeForToken } from "./exchange";
import {
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

function configFor(platform: string) {
  const provider = getProviderForPlatform(platform);
  const config = provider.oauthConfig?.();
  if (!config) throw new Error(`${platform} is not configured for OAuth connect (missing client credentials)`);
  return { provider, config };
}

/** Begin connect: the authorize URL to redirect to + the Set-Cookie headers (state, and PKCE for X). */
export function startPublishOAuth(platform: string, redirectUri: string): { url: string; cookies: string[] } {
  const { config } = configFor(platform);
  const { state, setCookie } = generateOAuthState();
  const cookies = [setCookie];
  let codeChallenge: string | undefined;
  if (config.usePkce) {
    const { verifier, challenge } = createPkcePair();
    codeChallenge = challenge;
    cookies.push(pkceCookie(verifier));
  }
  return { url: buildAuthorizeUrl(config, { state, redirectUri, codeChallenge }), cookies };
}

/**
 * Finish connect on the callback: verify CSRF state, exchange the code, resolve the account via the
 * provider's healthCheck, and upsert an `oauth` channel (through the single channel-creation path, so
 * the one-account-one-workspace invariant holds). Returns the channel id + cookies to clear.
 */
export async function completePublishOAuth(args: {
  platform: string;
  code: string;
  state: string;
  cookieHeader: string | null;
  redirectUri: string;
  workspaceId: string;
}): Promise<{ channelId: string; accountId: string; clearCookies: string[] }> {
  const { provider, config } = configFor(args.platform);
  verifyOAuthState(args.state, args.cookieHeader);

  let codeVerifier: string | undefined;
  if (config.usePkce) {
    codeVerifier = readPkceCookie(args.cookieHeader) ?? undefined;
    if (!codeVerifier) throw new Error("Missing PKCE verifier — restart the connection");
  }

  const tokens = await exchangeCodeForToken(config, { code: args.code, redirectUri: args.redirectUri, codeVerifier });
  const info = await provider.healthCheck(tokens); // resolves accountId + display/handle/avatar

  const account: ConnectedAccount = {
    platformId: info.accountId,
    displayName: info.displayName ?? info.handle ?? args.platform,
    username: info.handle,
    profilePicture: info.avatarUrl,
    tokens: fromTokenSet(tokens),
  };
  const platform = args.platform as Platform;
  // License gate: a non-Meta channel needs `non_meta_channels` (throws ProRequiredError → 402).
  await assertChannelsAllowed(args.workspaceId, platform, [account]);
  await upsertChannels(args.workspaceId, platform, [account], { connectionMode: "oauth" });

  const ch = await db.query.channels.findFirst({
    where: and(
      eq(channels.workspace_id, args.workspaceId),
      eq(channels.platform, platform),
      eq(channels.platform_id, info.accountId),
    ),
    columns: { id: true },
  });
  return { channelId: ch!.id, accountId: info.accountId, clearCookies: [clearOAuthStateCookie(), clearPkceCookie()] };
}
