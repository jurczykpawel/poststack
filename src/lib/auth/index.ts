import { jwtVerify } from "jose";
import { createHash, randomBytes, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, revokedTokens, workspaceMembers } from "@/db/schema";
import { env } from "@/lib/env";
import { BRAND } from "@/lib/brand";

// The bearer prefix gate: a key is "sk_live_<secret>", so the cheap pre-check is "sk_". Derived
// from BRAND.idPrefix so the prefix and this gate can never drift.
const BEARER_PREFIX = `${BRAND.idPrefix.split("_")[0]}_`;

export interface AuthContext {
  userId: string;
  workspaceId: string;
  /** "session" = dashboard JWT cookie | "api_key" = Bearer token */
  authMethod: "session" | "api_key";
  /** API key scopes. Empty = full access. Session auth always has full access. */
  scopes: string[];
}

/**
 * Check if the authenticated user has a required scope.
 * Empty scopes = full access (backward compatible).
 */
export function hasScope(auth: AuthContext, scope: string): boolean {
  return auth.scopes.length === 0 || auth.scopes.includes(scope);
}

/**
 * Authenticate + check scope in one call. Returns AuthContext or null.
 * Usage: const auth = await authenticateWithScope(request, "channels:read");
 */
export async function authenticateWithScope(
  request: Request,
  scope: string
): Promise<AuthContext | null> {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return null;
  if (!hasScope(auth, scope)) return null;
  return auth;
}

const JWT_SECRET = new TextEncoder().encode(env.JWT_SECRET);

/**
 * Authenticate a request using either:
 * 1. Session JWT cookie (dashboard frontend)
 * 2. Bearer API key (external integrations)
 *
 * Accepts the standard Web `Request` (works in App Router route handlers).
 */
export async function authenticate(
  request: Request,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  // Try Bearer API key first
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith(`Bearer ${BEARER_PREFIX}`)) {
    return authenticateApiKey(authHeader.slice(7), requiredWorkspaceId);
  }

  // Fall back to session JWT cookie (parse from Cookie header)
  return authenticateSession(request, requiredWorkspaceId);
}

async function authenticateApiKey(
  rawKey: string,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.key_hash, keyHash),
    columns: { id: true, workspace_id: true, scopes: true, expires_at: true },
  });

  if (!apiKey) return null;
  if (apiKey.expires_at && apiKey.expires_at < new Date()) return null;
  if (requiredWorkspaceId && apiKey.workspace_id !== requiredWorkspaceId) {
    return null;
  }

  // Update last_used_at in background (non-blocking)
  void db
    .update(apiKeys)
    .set({ last_used_at: new Date() })
    .where(eq(apiKeys.id, apiKey.id))
    .catch(() => {});

  return {
    userId: `api-key:${apiKey.id}`,
    workspaceId: apiKey.workspace_id,
    authMethod: "api_key",
    scopes: apiKey.scopes ?? [],
  };
}

/** Read the session token from a Cookie header (brand-neutral cookie name). One source for the
 *  three call-sites that need it (authenticate, page-auth middleware, logout) — no drift. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  return parseCookie(cookieHeader, BRAND.cookieName);
}

/** Parse a specific cookie value from the Cookie header. */
function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return null;
  }
}

async function authenticateSession(
  request: Request,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: BRAND.jwtIssuer,
      audience: BRAND.jwtIssuer,
      // Pin the verify algorithm to what signSession signs with (HS256). The symmetric Uint8Array
      // key already makes jose reject asymmetric (RS*/ES*) and `none` algs, so this is
      // defense-in-depth against a future refactor swapping the secret for a KeyObject/JWKS that
      // would otherwise re-open alg-confusion.
      algorithms: ["HS256"],
    });
    const userId = payload.sub as string;
    const workspaceId = payload.wid as string;
    const jti = payload.jti as string | undefined;

    if (!userId || !workspaceId) return null;
    if (requiredWorkspaceId && workspaceId !== requiredWorkspaceId) return null;

    // Check JWT denylist (invalidated on logout)
    if (jti) {
      const revoked = await db.query.revokedTokens.findFirst({ where: eq(revokedTokens.jti, jti) });
      if (revoked && revoked.expires_at > new Date()) return null;
    }

    // Verify the user is STILL an active member of the workspace named in the token — not
    // just that the user row exists. Otherwise a JWT keeps full workspace access after the
    // membership is removed, until expiry. The FK also implies the user exists.
    const membership = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.user_id, userId), eq(workspaceMembers.workspace_id, workspaceId)),
      columns: { user_id: true },
    });
    if (!membership) return null;

    return { userId, workspaceId, authMethod: "session", scopes: [] };
  } catch {
    return null;
  }
}

/**
 * Issue a signed session JWT with a unique jti for revocation support.
 */
export async function signSession(
  userId: string,
  workspaceId: string
): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({ wid: workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(BRAND.jwtIssuer)
    .setAudience(BRAND.jwtIssuer)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRY)
    .sign(JWT_SECRET);
}

/**
 * Invalidate a session JWT by adding its jti to the Postgres denylist.
 * `expires_at` matches the JWT's expiry so entries can be pruned afterwards.
 */
export async function invalidateSession(token: string): Promise<void> {
  try {
    // Verify issuer/audience too (logout is an unauthenticated endpoint, so the caller controls
    // the token). Otherwise a token merely signed with this JWT_SECRET — e.g. one minted by a
    // sibling service that shares the secret — could push an arbitrary jti onto the denylist.
    const { payload } = await jwtVerify(token, JWT_SECRET, { issuer: BRAND.jwtIssuer, audience: BRAND.jwtIssuer, algorithms: ["HS256"] });
    const jti = payload.jti;
    const exp = payload.exp;

    if (!jti || !exp) return;

    const expires_at = new Date(exp * 1000);
    if (expires_at > new Date()) {
      await db
        .insert(revokedTokens)
        .values({ jti: jti as string, expires_at })
        .onConflictDoUpdate({ target: revokedTokens.jti, set: { expires_at } });
    }
  } catch {
    // Token already expired or invalid — no need to denylist
  }
}

/**
 * Build a `Set-Cookie` header value for the session cookie.
 * An empty token with maxAge 0 clears it.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${BRAND.cookieName}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/**
 * Generate a new API key for a workspace.
 * Returns the plaintext key (shown once) and the prefix (stored).
 */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  const plaintext = `${BRAND.idPrefix}${secret}`;
  const prefix = plaintext.slice(0, 16); // idPrefix (8) + first 8 chars of the secret
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, prefix, hash };
}
