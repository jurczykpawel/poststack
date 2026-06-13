import type { TokenSet } from "./types";
import { PermanentError, TokenInvalidError, TransientError, type PublishPhase } from "./errors";

/** `phase` (PSA36) tags the resulting TransientError (5xx) so the worker knows whether a retry can
 *  safely re-run the publish; default `commit_uncertain` keeps the PSA2-safe behavior for callers
 *  that don't classify their step. */
export function classifyHttp(status: number, message?: string, phase: PublishPhase = "commit_uncertain"): Error {
  if (status === 401 || status === 403) {
    return new TokenInvalidError(`auth failed: ${message ?? status}`);
  }
  if (status >= 500) return new TransientError(`upstream ${status}`, phase);
  return new PermanentError(`request failed (${status}): ${message ?? ""}`);
}

/** Standard OAuth2 refresh_token grant. Preserves the old refresh token if none returned (#1383). */
export async function oauth2Refresh(args: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  extra?: Record<string, string>;
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    ...(args.extra ?? {}),
  });
  const res = await fetch(args.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    // OAuth2 'invalid_grant' = the refresh token is expired/revoked — unrecoverable, needs reconnect.
    // Must be TokenInvalid (-> needs_reauth) not a retryable error, else the worker retries forever.
    if (json.error === "invalid_grant") {
      throw new TokenInvalidError("refresh token invalid_grant — reconnect required");
    }
    throw classifyHttp(res.status, json.error);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? args.refreshToken, // #1383 preserve
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined,
  };
}
