import { jwtVerify } from "jose";
import { createHash, randomBytes, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

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
  if (authHeader?.startsWith("Bearer rs_")) {
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

  const apiKey = await prisma.apiKey.findUnique({
    where: { key_hash: keyHash },
    select: { id: true, workspace_id: true, scopes: true, expires_at: true },
  });

  if (!apiKey) return null;
  if (apiKey.expires_at && apiKey.expires_at < new Date()) return null;
  if (requiredWorkspaceId && apiKey.workspace_id !== requiredWorkspaceId) {
    return null;
  }

  // Update last_used_at in background (non-blocking)
  void prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: { last_used_at: new Date() },
    })
    .catch(() => {});

  return {
    userId: `api-key:${apiKey.id}`,
    workspaceId: apiKey.workspace_id,
    authMethod: "api_key",
    scopes: apiKey.scopes,
  };
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
  const token = parseCookie(request.headers.get("cookie"), "rs_session");
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, {
      issuer: "replystack",
      audience: "replystack",
    });
    const userId = payload.sub as string;
    const workspaceId = payload.wid as string;
    const jti = payload.jti as string | undefined;

    if (!userId || !workspaceId) return null;
    if (requiredWorkspaceId && workspaceId !== requiredWorkspaceId) return null;

    // Check JWT denylist (invalidated on logout)
    if (jti) {
      const revoked = await prisma.revokedToken.findUnique({ where: { jti } });
      if (revoked && revoked.expires_at > new Date()) return null;
    }

    // Verify user still exists (handles deleted/suspended accounts)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) return null;

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
    .setIssuer("replystack")
    .setAudience("replystack")
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
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const jti = payload.jti;
    const exp = payload.exp;

    if (!jti || !exp) return;

    const expires_at = new Date(exp * 1000);
    if (expires_at > new Date()) {
      await prisma.revokedToken.upsert({
        where: { jti },
        create: { jti, expires_at },
        update: { expires_at },
      });
    }
  } catch {
    // Token already expired or invalid — no need to denylist
  }
}

/**
 * Generate a new API key for a workspace.
 * Returns the plaintext key (shown once) and the prefix (stored).
 */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("hex");
  const plaintext = `rs_live_${secret}`;
  const prefix = plaintext.slice(0, 16); // "rs_live_" + first 8 chars
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, prefix, hash };
}
