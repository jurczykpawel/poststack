import { authenticate, authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/contacts/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { contactId } = await params;
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspace_id: auth.workspaceId },
    select: {
      id: true,
      display_name: true,
      email: true,
      avatar_url: true,
      is_subscribed: true,
      last_interaction_at: true,
      metadata: true,
      created_at: true,
      contact_channels: {
        select: {
          id: true,
          platform_sender_id: true,
          platform_username: true,
          channel: { select: { id: true, platform: true, display_name: true } },
        },
      },
      tags: {
        select: { tag: { select: { id: true, name: true, color: true } } },
      },
      _count: {
        select: { conversations: true, sequence_enrollments: true },
      },
    },
  });

  if (!contact) return ApiErrors.notFound();
  return ok(contact);
}

const patchSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  is_subscribed: z.boolean().optional(),
});

// PATCH /api/v1/contacts/:id
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { contactId } = await params;
  const existing = await prisma.contact.findFirst({
    where: { id: contactId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const updated = await prisma.contact.update({
    where: { id: contactId },
    data: parsed.data,
    select: {
      id: true,
      display_name: true,
      email: true,
      is_subscribed: true,
    },
  });

  return ok(updated);
}

// DELETE /api/v1/contacts/:id — erase a contact and all their data (GDPR).
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { contactId } = await params;
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, workspace_id: auth.workspaceId },
    select: { id: true, contact_channels: { select: { platform_sender_id: true } } },
  });
  if (!contact) return ApiErrors.notFound("Contact");

  // CommentLog isn't FK-linked to Contact (author_id is a platform id), so the
  // cascade doesn't reach it — erase it explicitly, workspace-scoped.
  const senderIds = contact.contact_channels.map((cc) => cc.platform_sender_id);
  if (senderIds.length > 0) {
    await prisma.commentLog.deleteMany({
      where: { workspace_id: auth.workspaceId, author_id: { in: senderIds } },
    });
  }

  // Cascade removes ContactChannel, Conversations + Messages, enrollments,
  // pending approvals and broadcast recipients ( foreign keys).
  await prisma.contact.delete({ where: { id: contactId } });

  return noContent();
}
