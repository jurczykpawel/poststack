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
  throw new Error(`${context} failed: ${body}`);
}
