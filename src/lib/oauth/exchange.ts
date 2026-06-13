import type { OAuthConfig, TokenSet } from "@/lib/providers/types";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  [k: string]: unknown;
}

/**
 * Exchange an authorization code for a {@link TokenSet} at a provider's token endpoint. Generic over
 * every publish provider via {@link OAuthConfig}: confidential clients that require HTTP Basic auth
 * (X) send creds in the header; the rest send them in the form body. PKCE `code_verifier` and the
 * `client_key` alias (TikTok) are honored. Throws on a non-2xx or a response with no access token.
 */
export async function exchangeCodeForToken(
  config: OAuthConfig,
  opts: { code: string; redirectUri: string; codeVerifier?: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    [config.clientIdParam ?? "client_id"]: config.clientId,
  });
  if (opts.codeVerifier) body.set("code_verifier", opts.codeVerifier);

  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (config.tokenAuthBasic) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_secret", config.clientSecret);
  }

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${res.status}): ${json.error ?? "unknown error"}`);
  }
  if (!json.access_token) {
    throw new Error("OAuth token exchange returned no access_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt:
      typeof json.expires_in === "number"
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : undefined,
  };
}
