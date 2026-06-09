import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { conversations, workspaceMembers } from "@/db/schema";
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
      // Projected so an API consumer can READ the assignment it set via PATCH.
      assigned_to: true,
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

  // assigned_to references users globally; only allow assigning to a member of THIS workspace
  // (a cross-workspace user id would be a misleading dangling reference).
  if (parsed.data.assigned_to) {
    const member = await db.query.workspaceMembers.findFirst({
      where: and(eq(workspaceMembers.workspace_id, auth.workspaceId), eq(workspaceMembers.user_id, parsed.data.assigned_to)),
      columns: { user_id: true },
    });
    if (!member) return ApiErrors.validationError({ assigned_to: ["User is not a member of this workspace"] });
  }

  const [updated] = await db
    .update(conversations)
    .set(parsed.data)
    // Scope the write by workspace too (consistent with DELETE), not just the prior findFirst.
    .where(and(eq(conversations.id, conversationId), eq(conversations.workspace_id, auth.workspaceId)))
    .returning({
      id: conversations.id,
      status: conversations.status,
      unread_count: conversations.unread_count,
      is_automation_paused: conversations.is_automation_paused,
      assigned_to: conversations.assigned_to,
    });

  return ok(updated);
}
