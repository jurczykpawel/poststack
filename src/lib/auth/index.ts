import { type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

export interface AuthContext {
  userId: string;
  workspaceId: string;
  /** "session" = dashboard JWT cookie | "api_key" = Bearer token */
  authMethod: "session" | "api_key";
}

const JWT_SECRET = new TextEncoder().encode(env.JWT_SECRET);

/**
 * Authenticate a request using either:
 * 1. Session JWT cookie (dashboard frontend)
 * 2. Bearer API key (external integrations)
 *
 * Usage in API route handlers:
 *   const auth = await authenticate(request, workspaceId?)
 *   if (!auth) return ApiErrors.unauthorized()
 */
export async function authenticate(
  request: NextRequest,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  // Try Bearer API key first
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer rs_")) {
    return authenticateApiKey(authHeader.slice(7), requiredWorkspaceId);
  }

  // Fall back to session JWT cookie
  return authenticateSession(request, requiredWorkspaceId);
}

async function authenticateApiKey(
  rawKey: string,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  const keyHash = createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await prisma.apiKey.findUnique({
    where: { key_hash: keyHash },
    select: { id: true, workspace_id: true, expires_at: true },
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
    userId: "api-key",
    workspaceId: apiKey.workspace_id,
    authMethod: "api_key",
  };
}

async function authenticateSession(
  request: NextRequest,
  requiredWorkspaceId?: string
): Promise<AuthContext | null> {
  const token = request.cookies.get("rs_session")?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const userId = payload.sub as string;
    const workspaceId = payload.wid as string;

    if (!userId || !workspaceId) return null;
    if (requiredWorkspaceId && workspaceId !== requiredWorkspaceId) return null;

    return { userId, workspaceId, authMethod: "session" };
  } catch {
    return null;
  }
}

/**
 * Issue a signed session JWT.
 * Set as HttpOnly cookie on the response.
 */
export async function signSession(
  userId: string,
  workspaceId: string
): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({ wid: workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(env.JWT_EXPIRY)
    .sign(JWT_SECRET);
}

/**
 * Generate a new API key for a workspace.
 * Returns the plaintext key (shown once) and the prefix (stored).
 */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const { randomBytes } = require("crypto") as typeof import("crypto");
  const secret = randomBytes(32).toString("hex");
  const plaintext = `rs_live_${secret}`;
  const prefix = plaintext.slice(0, 16); // "rs_live_" + first 8 chars
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, prefix, hash };
}
