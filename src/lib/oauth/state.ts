import { randomBytes, timingSafeEqual } from "crypto";

const COOKIE_NAME = "rs_oauth_state";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes

/**
 * Generate a random state value and the `Set-Cookie` header that stores it in a
 * short-lived cookie. The caller attaches `setCookie` to the redirect response.
 */
export function generateOAuthState(): { state: string; setCookie: string } {
  const state = randomBytes(16).toString("hex");
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  const setCookie = `${COOKIE_NAME}=${state}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  return { state, setCookie };
}

/** `Set-Cookie` value that clears the state cookie (one-time use). */
export function clearOAuthStateCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readStateCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? match.slice(COOKIE_NAME.length + 1) : null;
}

/**
 * Verify the state returned in the OAuth callback matches the cookie. Throws if
 * invalid. `cookieHeader` is the raw `Cookie` request header.
 */
export function verifyOAuthState(state: string, cookieHeader: string | null): void {
  const stored = readStateCookie(cookieHeader);
  if (
    !stored ||
    stored.length !== state.length ||
    !timingSafeEqual(Buffer.from(stored), Buffer.from(state))
  ) {
    throw new Error("Invalid OAuth state — possible CSRF attack");
  }
}

// ── PKCE verifier transport (publish-side OAuth, e.g. X) ──────────────────────────────────────────
// The PKCE code_verifier is generated on the authorize leg and needed again on the callback leg to
// prove possession. We stash it in a short-lived HttpOnly cookie (same lifetime/CSRF posture as the
// state cookie); the callback reads it, exchanges, then clears it. Never exposed to JS or the URL.
const PKCE_COOKIE_NAME = "rs_oauth_pkce";

/** `Set-Cookie` value stashing the PKCE verifier for the callback leg. */
export function pkceCookie(verifier: string): string {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${PKCE_COOKIE_NAME}=${verifier}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

/** Read the PKCE verifier from the raw `Cookie` header (null when absent). */
export function readPkceCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE_NAME}=`));
  return match ? match.slice(PKCE_COOKIE_NAME.length + 1) : null;
}

/** `Set-Cookie` value that clears the PKCE verifier cookie (one-time use). */
export function clearPkceCookie(): string {
  return `${PKCE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
