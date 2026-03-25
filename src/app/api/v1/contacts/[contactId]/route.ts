import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/contacts/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
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
  const auth = await authenticate(request).catch(() => null);
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
