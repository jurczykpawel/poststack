import type { TokenSet } from "./types";
import { PermanentError, PermissionError, PaymentRequiredError, RateLimitedError, TokenInvalidError, TransientError, type PublishPhase } from "./errors";

type HttpContext = {
  provider?: "meta" | "threads" | "youtube" | "x" | "linkedin" | "tiktok" | "telegram";
  headers?: Headers;
  body?: unknown;
};

/** Retry-After (RFC 9110) or X's Unix reset timestamp; bounded to 1s–24h. */
function retryDelay({ headers, provider, body }: HttpContext): number {
  const tg = (body as { parameters?: { retry_after?: unknown } } | undefined)?.parameters?.retry_after;
  if (provider === "telegram" && typeof tg === "number" && Number.isFinite(tg)) return Math.max(1, Math.min(86400, Math.ceil(tg)));
  const value = headers?.get("retry-after")?.trim();
  let seconds = value && /^\d+$/.test(value) ? Number(value) :
    value && /[a-z]{3},/i.test(value) ? (Date.parse(value) - Date.now()) / 1000 : NaN;
  if (!Number.isFinite(seconds) && provider === "x") {
    const reset = headers?.get("x-rate-limit-reset")?.trim();
    if (reset && /^\d+$/.test(reset)) seconds = Number(reset) - Date.now() / 1000;
  }
  return Number.isFinite(seconds) ? Math.max(1, Math.min(86400, Math.ceil(seconds))) : 60;
}

/** Provider-specific documented codes only; an unrecognized 403 never invalidates a token.
 * phase remains attached even when a response suggests waiting: it does not authorize re-publish. */
export function classifyHttp(
  status: number, message?: string, phase: PublishPhase = "commit_uncertain", context: HttpContext = {},
): Error {
  const body = context.body as { error?: { code?: unknown; message?: string; errors?: { reason?: string }[] }; type?: string; title?: string; detail?: string } | undefined;
  const code = body?.error?.code;
  const provider = context.provider;
  const detail = message || body?.error?.message || body?.detail || body?.title || String(code ?? status);
  const meta = provider === "meta" || provider === "threads";
  const reasons = Array.isArray(body?.error?.errors) ? body.error.errors.map(e => e?.reason) : [];
  if (status === 429 || (status === 503 && context.headers?.has("retry-after"))) {
    return new RateLimitedError(`provider rate limit/unavailable: ${detail}`, retryDelay(context), phase);
  }
  if (status >= 500) return new TransientError(`upstream ${status}`, phase);
  if (provider === "tiktok" && code === "scope_not_authorized") {
    return new PermissionError("TikTok permission required: video.publish (scope_not_authorized)");
  }
  if (status === 401 || (meta && [190, 102, 467].includes(Number(code))) ||
      (provider === "tiktok" && code === "access_token_invalid")) {
    return new TokenInvalidError(`auth failed: ${detail}`);
  }
  if (provider === "x" && status === 402) return new PaymentRequiredError("X payment/credits required — check the developer account billing");
  const limited = (provider === "youtube" && reasons.some(r => ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"].includes(r ?? ""))) ||
    (meta && [4, 17, 32, 613, 80004].includes(Number(code))) ||
    (provider === "tiktok" && code === "rate_limit_exceeded") ||
    (provider === "x" && (body?.type === "https://api.x.com/2/problems/usage-capped"));
  if (limited) return new RateLimitedError(`provider quota/rate limit: ${detail}`, retryDelay(context), phase);
  if (status === 403 || (meta && [10, 200, 294].includes(Number(code)))) {
    return new PermissionError(`provider permission/access required: ${detail}`);
  }
  return new PermanentError(`request failed (${status}): ${detail}`);
}

/** Standard OAuth2 refresh_token grant. Preserves the old refresh token if none returned (#1383). */
export async function oauth2Refresh(args: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  extra?: Record<string, string>;
  tokenAuthBasic?: boolean;
}): Promise<TokenSet> {
  if (!args.refreshToken) throw new TokenInvalidError("refresh token missing — reconnect required");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    ...(args.extra ?? {}),
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (args.tokenAuthBasic) {
    headers.authorization = `Basic ${Buffer.from(`${args.clientId}:${args.clientSecret}`).toString("base64")}`;
    body.delete("client_id");
    body.delete("client_secret");
  }
  const res = await fetch(args.tokenUrl, {
    method: "POST",
    headers,
    body,
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (res.status >= 500) throw classifyHttp(res.status, undefined, "pre_commit", { headers: res.headers, body: json });
  if (!res.ok || !json.access_token || json.error) {
    // OAuth2 'invalid_grant' = the refresh token is expired/revoked — unrecoverable, needs reconnect.
    // Must be TokenInvalid (-> needs_reauth) not a retryable error, else the worker retries forever.
    if (json.error === "invalid_client") {
      throw new TokenInvalidError("application credentials rejected (invalid_client) — check application settings and reconnect");
    }
    if (json.error === "invalid_grant") {
      throw new TokenInvalidError("refresh token invalid_grant — reconnect required");
    }
    throw classifyHttp(res.status, json.error, "pre_commit", { headers: res.headers, body: json });
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? args.refreshToken, // #1383 preserve
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : undefined,
  };
}
