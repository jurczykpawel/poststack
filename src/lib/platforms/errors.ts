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
 * Meta error CODES that are terminal specifically for a comment private-reply. Private replies obey
 * a policy domain distinct from the 24h messaging window: one reply per comment, only within the
 * comment's eligibility window (~7 days), and the recipient must be able to receive it. Those
 * rejections surface as application / permission / parameter errors — none of which a retry can fix:
 *  - 10  : application does not have permission for this action / policy block (comment too old,
 *          already privately replied, recipient cannot receive)
 *  - 100 : invalid parameter (e.g. the comment no longer exists / is not eligible)
 *  - 200 : permissions error
 * Deliberately EXCLUDES the transient codes (1 = unknown, 2 = service temporarily unavailable) and
 * the rate-limit codes (handled earlier), so a genuinely retryable failure is never dropped. The
 * narrow 24h-window subcodes stay handled globally by {@link isMetaWindowError}; this covers the
 * private-reply rejections that fall OUTSIDE that subcode set.
 *
 * Confidence caveat: the exact private-reply subcodes are Meta-specific and could not be confirmed
 * against a live error. This keys on the error-code CLASS instead, and is scoped to the private-reply
 * call site (see {@link assertMetaOk}) so it can never widen the terminal classification of a normal
 * DM/comment send. An unparseable body (e.g. a 5xx HTML page) stays transient.
 */
const TERMINAL_PRIVATE_REPLY_ERROR_CODES = new Set([10, 100, 200]);

export function isMetaPrivateReplyPolicyError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number } }).error;
    if (err && typeof err.code === "number") return TERMINAL_PRIVATE_REPLY_ERROR_CODES.has(err.code);
  } catch {
    // not JSON (e.g. a 5xx HTML body) — treat as transient, let it retry
  }
  return false;
}

/**
 * Meta SEND-level terminal subcodes — a per-recipient PERMANENT failure that no retry can fix, so
 * the delivery drops instead of dead-lettering every attempt. Distinct from the 24h-window policy
 * subcodes ({@link TERMINAL_META_POLICY_SUBCODES}): these are recipient-reachability terminals.
 *  - 2018001: "No matching user found" — the PSID/IGSID is stale (the recipient deleted their
 *    account or is otherwise permanently unreachable). Documented permanent; without this it recurs
 *    on every DM / drip step to that contact, dead-lettering each one.
 * Keyed on the SUBCODE (never a bare overloaded code like 100), so a transient failure is never
 * mis-classified — applies in any send context safely, the same way {@link isMetaWindowError} does
 *.
 */
const TERMINAL_META_SEND_SUBCODES = new Set([2018001]);

export function isMetaUnreachableRecipientError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { error_subcode?: number } }).error;
    if (err && typeof err.error_subcode === "number") return TERMINAL_META_SEND_SUBCODES.has(err.error_subcode);
  } catch {
    // not JSON — transient
  }
  return false;
}

/**
 * Meta error CODE that is terminal for a public-comment send (sendComment). Code 10 = "application
 * does not have permission for this action" — on a comment that means commenting is disabled on the
 * post or the post is blocked: a per-target policy block no retry can fix. Scoped to the
 * "send comment" call site (see {@link assertMetaOk}) so it can't widen a DM. Deliberately code-10
 * ONLY: bare code-100 is overloaded (often transient) and code-200 (permissions) is a channel-wide
 * capability loss, not a per-comment terminal — both stay retryable here.
 */
export function isMetaCommentPolicyError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number } }).error;
    if (err && typeof err.code === "number") return err.code === 10;
  } catch {
    // not JSON — transient
  }
  return false;
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
  // A per-recipient PERMANENT failure (e.g. a stale PSID whose account was deleted — subcode
  // 2018001): no retry can fix it, so drop this delivery instead of dead-lettering every attempt.
  // Subcode-keyed, so it applies safely in any send context without widening a transient error
  //.
  if (isMetaUnreachableRecipientError(body)) {
    throw new MessagingPolicyError(`${context}: recipient is permanently unreachable`);
  }
  // Private-reply policy rejections (comment too old, already replied, ineligible) are terminal too,
  // but use Meta error CODES outside the messaging-window subcode allowlist. Scope this broader
  // classification to the private-reply call site via `context` so it can never affect a normal DM
  // or public-comment send. Token / rate-limit / window were already handled above; transient API
  // codes (1/2) and unparseable bodies fall through to the retryable generic error.
  if (/private reply/i.test(context) && isMetaPrivateReplyPolicyError(body)) {
    throw new MessagingPolicyError(`${context}: rejected by platform private-reply policy`);
  }
  // Public-comment terminal: code 10 on a sendComment = commenting disabled / post blocked. Scoped
  // to the "send comment" call site so it can't widen a DM, and code-10-only so bare-100 (overloaded)
  // and code-200 (channel-wide capability loss) stay retryable.
  if (/send comment/i.test(context) && isMetaCommentPolicyError(body)) {
    throw new MessagingPolicyError(`${context}: rejected by platform comment policy`);
  }
  throw new Error(`${context} failed: ${body}`);
}
