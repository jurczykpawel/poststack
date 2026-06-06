import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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

  const conversations = await prisma.conversation.findMany({
    where: {
      workspace_id: auth.workspaceId,
      ...(status ? { status } : {}),
      ...(channel_id ? { channel_id } : {}),
      ...(cursor
        ? { last_message_at: { lt: new Date(cursor) } }
        : {}),
    },
    orderBy: { last_message_at: "desc" },
    take: limit + 1,
    select: {
      id: true,
      platform: true,
      status: true,
      last_message_at: true,
      last_message_preview: true,
      unread_count: true,
      is_automation_paused: true,
      channel: {
        select: { id: true, display_name: true, platform: true },
      },
      contact: {
        select: { id: true, display_name: true, avatar_url: true, contact_channels: {
          select: { platform_sender_id: true, platform_username: true },
          take: 1,
        }},
      },
    },
  });

  const hasMore = conversations.length > limit;
  const items = hasMore ? conversations.slice(0, limit) : conversations;
  const nextCursor =
    hasMore && items.length > 0
      ? items[items.length - 1].last_message_at?.toISOString()
      : null;

  return ok(items, { has_more: hasMore, next_cursor: nextCursor });
}
