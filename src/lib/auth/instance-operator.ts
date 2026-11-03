import { asc, eq } from "drizzle-orm";
import { apiKeys, users } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { ApiError } from "@/lib/api/response";
import { authenticate, type AuthContext } from ".";
import type { ApiScope } from "./scopes";

/** Whether a user is an instance operator (INSTANCE_ADMIN_EMAILS, or the first user when unset). */
async function isOperatorUser(userId: string): Promise<boolean> {
  const emails = env.INSTANCE_ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.length > 0) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId), columns: { email: true },
    });
    return !!user && emails.includes(user.email.trim().toLowerCase());
  }
  const first = await db.query.users.findFirst({
    orderBy: [asc(users.created_at), asc(users.id)], columns: { id: true },
  });
  return first?.id === userId;
}

/** Instance administration belongs to a user session, independent of workspace roles. */
export async function isInstanceOperator(auth: AuthContext): Promise<boolean> {
  return auth.authMethod === "session" && isOperatorUser(auth.userId);
}

/**
 * Auth for instance-wide API operations. Null = not authenticated; throws 403 otherwise unless the caller is
 * an operator session, or an API key that lists `scope` EXPLICITLY (an empty scope list never grants
 * `instance_*`) and whose creator is still an operator right now.
 */
export async function authenticateInstanceScope(request: Request, scope: ApiScope): Promise<AuthContext | null> {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return null;
  if (auth.authMethod === "session") {
    if (!(await isOperatorUser(auth.userId))) throw new ApiError("forbidden", "Managed by the instance operator", 403);
    return auth;
  }
  if (!auth.scopes.includes(scope)) throw new ApiError("insufficient_scope", `This operation requires ${scope}`, 403);
  const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, auth.userId.slice("api-key:".length)), columns: { created_by_user_id: true } });
  if (!key?.created_by_user_id || !(await isOperatorUser(key.created_by_user_id))) {
    throw new ApiError("forbidden", "This key's creator is no longer an instance operator", 403);
  }
  return auth;
}
