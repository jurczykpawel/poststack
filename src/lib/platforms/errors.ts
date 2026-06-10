/**
 * A platform access token is invalid, expired, or revoked. Distinct from a
 * transient failure: the channel needs re-authentication, not a retry.
 */
export class TokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenInvalidError";
  }
}

/**
 * The platform refused the send for a per-delivery reason that retrying cannot fix — e.g. a Meta
 * message sent outside the 24h customer-service window without an eligible tag, or a
 * Telegram chat where the bot was blocked/kicked by that user. The token/channel itself
 * is fine; only THIS delivery is terminal (dropped), not retried, so a stale step can't grind
 * every attempt into the dead-letter queue — and the channel is never parked for it.
 */
export class MessagingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingPolicyError";
  }
}

/**
 * The platform is rate-limiting us (HTTP 429 or a Meta throttle code). Distinct from a generic
 * transient error: retrying is correct, but only AFTER the provider's `Retry-After` window — hammering
 * it on the short default backoff just burns the retry budget and dead-letters a send that would have
 * gone through once the window cleared. Carries the suggested wait so the caller can schedule
 * the replay precisely.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Meta throttling error codes (app/user/page request limits + generic API rate limit). */
const META_RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Default wait when the platform 429s without a usable `Retry-After`. */
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
/** Ceiling so a bogus/hostile `Retry-After` can't park a send for hours. */
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;

/** True for a Meta response body carrying a throttling error code (independent of HTTP status). */
export function isMetaRateLimitError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number } }).error;
    if (err && typeof err.code === "number") return META_RATE_LIMIT_CODES.has(err.code);
  } catch {
    // not JSON
  }
  return false;
}

/**
 * Resolve a `Retry-After` header to milliseconds. Accepts both forms HTTP allows — a delta in
 * seconds or an HTTP-date — clamps to a sane ceiling, and falls back to a fixed backoff when the
 * header is absent or unparseable.
 */
export function parseRetryAfterMs(headers: Headers, now: number = Date.now()): number {
  const raw = headers.get("retry-after");
  if (raw) {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RATE_LIMIT_BACKOFF_MS);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(date - now, MAX_RATE_LIMIT_BACKOFF_MS));
  }
  return DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

/**
 * Known terminal Meta messaging-policy subcodes — retrying cannot fix any of these, so the
 * delivery is dropped rather than ground through the retry budget to the dead-letter queue. Kept
 * to a documented allowlist so a genuinely transient failure (unknown subcode) stays retryable.
 *  - 2018278: message sent outside the 24h customer-service window (no eligible tag)
 *  - 2018109: message tag used outside its allowed policy
 *  - 2042002: messaging blocked by a policy condition the send cannot satisfy
 */
const TERMINAL_META_POLICY_SUBCODES = new Set([2018278, 2018109, 2042002]);

/**
 * Detect Meta's terminal messaging-policy rejections. Messenger/IG return e.g.
 * `{ error: { code: 10, error_subcode: 2018278, message: "This message is sent outside of
 * allowed window." } }` — a policy block, not a transient error. Keyed on a narrow subcode
 * allowlist (plus the documented window message text) so a genuinely transient failure is never
 * mis-classified as terminal.
 */
export function isMetaWindowError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number; error_subcode?: number } }).error;
    if (err && typeof err.error_subcode === "number" && TERMINAL_META_POLICY_SUBCODES.has(err.error_subcode)) return true;
  } catch {
    // not JSON — fall through to the text heuristic
  }
  return /outside of allowed window|outside the allowed window|24[- ]?hour (?:window|standard messaging)/i.test(body);
}

/**
 * Detect Meta Graph "invalid/expired access token" errors. Meta returns
 * `{ error: { type: "OAuthException", code: 190, ... } }` for invalid/expired/
 * revoked tokens. Code 190 is token-specific; other OAuthException codes
 * (e.g. 200 = permissions) are NOT a reauth case, so we key on code 190.
 */
export function isMetaTokenError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number } }).error;
    if (err && typeof err.code === "number") return err.code === 190;
  } catch {
    // not JSON — fall through to the text heuristic
  }
  return /validating access token|session has expired|access token has expired|OAuthException/i.test(body);
}

/** Throw a typed error if a Meta Graph response is not ok. */
export async function assertMetaOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text();
  if (isMetaTokenError(body)) {
    throw new TokenInvalidError(`${context}: access token is invalid or expired`);
  }
  if (res.status === 429 || isMetaRateLimitError(body)) {
    throw new RateLimitError(`${context}: rate limited by the platform`, parseRetryAfterMs(res.headers));
  }
  if (isMetaWindowError(body)) {
    throw new MessagingPolicyError(`${context}: outside the allowed messaging window`);
  }
  throw new Error(`${context} failed: ${body}`);
}
