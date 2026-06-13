import { createHash, randomBytes } from "crypto";
import type { OAuthConfig } from "@/lib/providers/types";

/**
 * Build a provider's OAuth2 authorization-code URL from its {@link OAuthConfig}. Generic across every
 * publish provider — the per-platform quirks (TikTok's `client_key`, comma-separated scopes, X's PKCE,
 * Google's `access_type=offline`) are all expressed as config, so adding a provider never forks this.
 */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  opts: { state: string; redirectUri: string; codeChallenge?: string },
): string {
  const params = new URLSearchParams({
    [config.clientIdParam ?? "client_id"]: config.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: config.scopes.join(config.scopeSeparator ?? " "),
    state: opts.state,
    ...(config.extraAuthParams ?? {}),
  });
  if (opts.codeChallenge) {
    params.set("code_challenge", opts.codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  const sep = config.authorizeUrl.includes("?") ? "&" : "?";
  return `${config.authorizeUrl}${sep}${params.toString()}`;
}

const base64url = (b: Buffer): string => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Create a PKCE verifier + its S256 challenge (RFC 7636). Pass an existing `verifier` to recompute the
 * same challenge (used on the callback leg). X (Twitter) OAuth2 requires PKCE.
 */
export function createPkcePair(verifier?: string): { verifier: string; challenge: string } {
  const v = verifier ?? base64url(randomBytes(32)); // 43-char URL-safe verifier
  const challenge = base64url(createHash("sha256").update(v).digest());
  return { verifier: v, challenge };
}
