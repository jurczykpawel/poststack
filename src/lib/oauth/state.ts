import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { SessionAuthContext } from "@/lib/auth";

const COOKIE_NAME = "rs_oauth_state";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes (owner decision 2026-11-11: keep; an expiry gets its own message)
const COOKIE_PATH = "/api/oauth";
const STATE_VERSION = "oauth-state-v1";

export const OAUTH_FLOWS = {
  facebook: "facebook",
  instagram: "instagram",
  instagramLogin: "instagram-login",
  youtube: "youtube",
  gmail: "gmail",
} as const;

/** `subAccounts`: the opt-in "connect pages" variant — the callback lets the user pick sub-accounts. */
export type OAuthPurpose = { kind: "insights"; channelId: string; transport: string } | { kind: "connect"; subAccounts?: true };

export type OAuthFlow = (typeof OAUTH_FLOWS)[keyof typeof OAUTH_FLOWS] | `connect:${string}`;

export function connectOAuthFlow(platform: string): `connect:${string}` {
  return `connect:${platform}`;
}

function secureAttribute(): string {
  return process.env.NODE_ENV === "production" ? " Secure;" : "";
}

export function oauthCookie(name: string, value: string, maxAge: number, path = COOKIE_PATH): string {
  return `${name}=${value}; HttpOnly;${secureAttribute()} SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;
}

/** Read one cookie's value from the raw `Cookie` header (null when absent). */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  const match = cookieHeader?.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function signature(state: string, auth: SessionAuthContext, flow: OAuthFlow, context: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required for OAuth state");
  const payload = JSON.stringify([
    STATE_VERSION,
    state,
    auth.userId,
    auth.workspaceId,
    auth.sessionId,
    flow,
    context,
  ]);
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** The state cookie is gone (browser dropped it after Max-Age) or its signed expiry passed — not a forged/mismatched state. */
export class OAuthStateExpiredError extends Error {
  override readonly name = "OAuthStateExpiredError";
  constructor() { super("OAuth state expired"); }
}

export function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Generate a random state value and the `Set-Cookie` header that stores it in a
 * short-lived cookie. The caller attaches `setCookie` to the redirect response.
 */
export function generateOAuthState(
  auth: SessionAuthContext,
  flow: OAuthFlow,
  purpose: OAuthPurpose = { kind: "connect" },
): { state: string; setCookie: string } {
  validatePurpose(purpose, flow);
  const state = randomBytes(16).toString("hex");
  const context = Buffer.from(JSON.stringify({ purpose, expiresAt: Date.now() + COOKIE_MAX_AGE * 1000 })).toString("base64url");
  const setCookie = oauthCookie(
    COOKIE_NAME,
    `${state}.${context}.${signature(state, auth, flow, context)}`,
    COOKIE_MAX_AGE,
  );
  return { state, setCookie };
}

/** `Set-Cookie` value that clears the state cookie (one-time use). */
export function clearOAuthStateCookie(): string {
  return oauthCookie(COOKIE_NAME, "", 0);
}

const readStateCookie = (cookieHeader: string | null) => readCookie(cookieHeader, COOKIE_NAME);

/**
 * Verify the state returned in the OAuth callback matches the cookie. Throws if
 * invalid. `cookieHeader` is the raw `Cookie` request header.
 */
export function verifyOAuthStateCookie(state: string, cookieHeader: string | null): void {
  const stored = readStateCookie(cookieHeader);
  if (stored === null) throw new OAuthStateExpiredError();
  const separator = stored.indexOf(".");
  const storedState = separator > 0 ? stored.slice(0, separator) : "";
  if (!safeEqual(storedState, state)) {
    throw new Error("Invalid OAuth state");
  }
}

/** Verify that the callback belongs to the session and connection flow that initiated it. */
export function verifyOAuthState(
  state: string,
  cookieHeader: string | null,
  auth: SessionAuthContext,
  flow: OAuthFlow,
): OAuthPurpose {
  verifyOAuthStateCookie(state, cookieHeader);
  const stored = readStateCookie(cookieHeader)!;
  const [, context, storedSignature, extra] = stored.split(".");
  if (!context || !storedSignature || extra || !safeEqual(storedSignature, signature(state, auth, flow, context))) {
    throw new Error("Invalid OAuth state");
  }
  const parsed = JSON.parse(Buffer.from(context, "base64url").toString());
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt > Date.now() + COOKIE_MAX_AGE * 1000) throw new Error("Invalid OAuth state");
  if (parsed.expiresAt <= Date.now()) throw new OAuthStateExpiredError(); // signature already verified, so this is a genuine timeout
  validatePurpose(parsed.purpose, flow);
  return parsed.purpose;
}

function validatePurpose(purpose: OAuthPurpose, flow: OAuthFlow): void {
  if (purpose?.kind === "connect" && Object.keys(purpose).length === 1) return;
  if (purpose?.kind === "connect" && purpose.subAccounts === true && Object.keys(purpose).length === 2 && flow.startsWith("connect:")) return;
  if (purpose?.kind !== "insights" || Object.keys(purpose).length !== 3 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(purpose.channelId) ||
    !((flow === "instagram" && purpose.transport === "facebook") || (flow === "instagram-login" && purpose.transport === "instagram_business"))) throw new Error("Invalid OAuth purpose");
}

// ── PKCE verifier transport (publish-side OAuth, e.g. X) ──────────────────────────────────────────
// The PKCE code_verifier is generated on the authorize leg and needed again on the callback leg to
// prove possession. We stash it in a short-lived HttpOnly cookie (same lifetime/CSRF posture as the
// state cookie); the callback reads it, exchanges, then clears it. Never exposed to JS or the URL.
const PKCE_COOKIE_NAME = "rs_oauth_pkce";

/** `Set-Cookie` value stashing the PKCE verifier for the callback leg. */
export function pkceCookie(verifier: string): string {
  return oauthCookie(PKCE_COOKIE_NAME, verifier, COOKIE_MAX_AGE);
}

/** Read the PKCE verifier from the raw `Cookie` header (null when absent). */
export function readPkceCookie(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, PKCE_COOKIE_NAME);
}

/** `Set-Cookie` value that clears the PKCE verifier cookie (one-time use). */
export function clearPkceCookie(): string {
  return oauthCookie(PKCE_COOKIE_NAME, "", 0);
}
