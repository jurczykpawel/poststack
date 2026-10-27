import { asc, eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import type { AuthContext } from ".";

/** Instance administration belongs to a user session, independent of workspace roles. */
export async function isInstanceOperator(auth: AuthContext): Promise<boolean> {
  if (auth.authMethod !== "session") return false;
  const emails = env.INSTANCE_ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (emails.length > 0) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, auth.userId), columns: { email: true },
    });
    return !!user && emails.includes(user.email.trim().toLowerCase());
  }
  const first = await db.query.users.findFirst({
    orderBy: [asc(users.created_at), asc(users.id)], columns: { id: true },
  });
  return first?.id === auth.userId;
}
