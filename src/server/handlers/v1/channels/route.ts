import { and, eq, asc, count } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels, messages, conversations } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// GET /api/v1/channels — list all channels for the workspace
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "channels:read");
  if (!auth) return ApiErrors.unauthorized();

  const rows = await db.query.channels.findMany({
    where: eq(channels.workspace_id, auth.workspaceId),
    orderBy: asc(channels.created_at),
    columns: {
      id: true,
      platform: true,
      platform_id: true,
      display_name: true,
      username: true,
      profile_picture: true,
      status: true,
      connection_mode: true,
      last_error: true,
      last_health_at: true,
      created_at: true,
    },
  });

  // `is_active` kept as a computed alias for backward compatibility.
  // `held_count` surfaces outbound parked while the channel was down (REL5).
  const withHeld = await Promise.all(
    rows.map(async (c) => {
      const [{ n }] = await db
        .select({ n: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
        .where(and(eq(messages.status, "held"), eq(conversations.channel_id, c.id)));
      return { ...c, is_active: c.status === "active", held_count: Number(n) };
    }),
  );
  return ok(withHeld);
}
