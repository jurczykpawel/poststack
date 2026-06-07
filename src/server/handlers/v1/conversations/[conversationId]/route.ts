import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/conversations/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.workspace_id, auth.workspaceId)),
    columns: {
      id: true,
      platform: true,
      status: true,
      last_message_at: true,
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

  if (!conversation) return ApiErrors.notFound();
  return ok(conversation);
}

const patchSchema = z.object({
  status: z.enum(["open", "closed", "snoozed"]).optional(),
  is_automation_paused: z.boolean().optional(),
  unread_count: z.literal(0).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
});

// PATCH /api/v1/conversations/:id
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const existing = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, conversationId), eq(conversations.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const [updated] = await db
    .update(conversations)
    .set(parsed.data)
    .where(eq(conversations.id, conversationId))
    .returning({
      id: conversations.id,
      status: conversations.status,
      unread_count: conversations.unread_count,
      is_automation_paused: conversations.is_automation_paused,
      assigned_to: conversations.assigned_to,
    });

  return ok(updated);
}
