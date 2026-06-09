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
 * The platform refused the send for a messaging-policy reason that retrying cannot fix —
 * most notably a message sent outside the 24h customer-service window without an eligible
 * message tag. Distinct from a transient failure: the delivery is terminal (dropped), not
 * retried, so a stale sequence step can't grind every attempt to the dead-letter queue.
 */
export class MessagingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingPolicyError";
  }
}

/**
 * Detect Meta's "outside the 24-hour window" rejection. Messenger/IG return
 * `{ error: { code: 10, error_subcode: 2018278, message: "This message is sent outside of
 * allowed window." } }` (and a few tag-related codes) — a policy block, not a transient error.
 * Keyed narrowly (subcode + the documented message text) so a genuinely transient failure is
 * never mis-classified as terminal.
 */
export function isMetaWindowError(body: string): boolean {
  try {
    const err = (JSON.parse(body) as { error?: { code?: number; error_subcode?: number } }).error;
    if (err && err.error_subcode === 2018278) return true;
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
  if (isMetaWindowError(body)) {
    throw new MessagingPolicyError(`${context}: outside the allowed messaging window`);
  }
  throw new Error(`${context} failed: ${body}`);
}
