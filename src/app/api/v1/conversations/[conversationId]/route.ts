import { authenticate, authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/conversations/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { conversationId } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspace_id: auth.workspaceId },
    select: {
      id: true,
      platform: true,
      status: true,
      last_message_at: true,
      unread_count: true,
      is_automation_paused: true,
      channel: { select: { id: true, display_name: true, platform: true } },
      contact: {
        select: {
          id: true,
          display_name: true,
          avatar_url: true,
          contact_channels: {
            select: { platform_sender_id: true, platform_username: true },
            take: 1,
          },
        },
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
  const existing = await prisma.conversation.findFirst({
    where: { id: conversationId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: parsed.data,
    select: {
      id: true,
      status: true,
      unread_count: true,
      is_automation_paused: true,
      assigned_to: true,
    },
  });

  return ok(updated);
}
