import { and, eq, asc, count, inArray } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { channels, messages, conversations } from "@/db/schema";
import { channelCapabilities } from "@/lib/channels/capabilities";
import { messagingConnection } from "@/lib/channels/ig-connection";
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
      messaging_token_expires_at: true,
    },
  });

  // `is_active` kept as a computed alias for backward compatibility.
  // `held_count` surfaces outbound parked while the channel was down. One grouped count for
  // all channels instead of a join-count per channel (N+1) — mirrors the dashboard's loadChannels
  //.
  const ids = rows.map((r) => r.id);
  const heldCounts = ids.length
    ? await db
        .select({ channel_id: conversations.channel_id, n: count() })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
        .where(and(eq(messages.status, "held"), inArray(conversations.channel_id, ids)))
        .groupBy(conversations.channel_id)
    : [];
  const heldByChannel = new Map(heldCounts.map((h) => [h.channel_id, Number(h.n)]));
  const withHeld = rows.map((c) => {
    const capabilities = channelCapabilities({ platform: c.platform, connection_mode: c.connection_mode });
    return {
      ...c,
      is_active: c.status === "active",
      held_count: heldByChannel.get(c.id) ?? 0,
      messaging_token_expires_at: c.messaging_token_expires_at ?? null,
      messaging_connection: messagingConnection({ platform: c.platform, messaging_token_expires_at: c.messaging_token_expires_at ?? null }),
      capabilities,
      // Explicit up-front publish flag so a client doesn't have to publish-and-fail to learn an
      // inbox-only channel (e.g. Telegram) can't publish.
      can_publish: capabilities.includes("publish"),
    };
  });
  return ok(withHeld);
}
