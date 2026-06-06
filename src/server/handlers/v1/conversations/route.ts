import { and, eq, lt, desc, type SQL } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["open", "closed", "snoozed"]).optional(),
  channel_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(), // ISO datetime for cursor pagination
});

// GET /api/v1/conversations
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  const { status, channel_id, limit, cursor } = parsed.data;

  const conds: SQL[] = [eq(conversations.workspace_id, auth.workspaceId)];
  if (status) conds.push(eq(conversations.status, status));
  if (channel_id) conds.push(eq(conversations.channel_id, channel_id));
  if (cursor) conds.push(lt(conversations.last_message_at, new Date(cursor)));

  const rows = await db.query.conversations.findMany({
    where: and(...conds),
    orderBy: desc(conversations.last_message_at),
    limit: limit + 1,
    columns: {
      id: true,
      platform: true,
      status: true,
      last_message_at: true,
      last_message_preview: true,
      unread_count: true,
      is_automation_paused: true,
    },
    with: {
      channel: { columns: { id: true, display_name: true, platform: true } },
      contact: {
        columns: { id: true, display_name: true, avatar_url: true },
        with: { contact_channels: { columns: { platform_sender_id: true, platform_username: true }, limit: 1 } },
      },
    },
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && items.length > 0 ? (items[items.length - 1].last_message_at?.toISOString() ?? null) : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}
