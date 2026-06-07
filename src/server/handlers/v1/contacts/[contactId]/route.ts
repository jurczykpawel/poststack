import { and, eq, inArray } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { contacts, commentLogs, conversations, sequenceEnrollments } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/contacts/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { contactId } = await params;
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
    columns: {
      id: true,
      display_name: true,
      email: true,
      avatar_url: true,
      is_subscribed: true,
      last_interaction_at: true,
      metadata: true,
      created_at: true,
    },
    with: {
      contact_channels: {
        columns: { id: true, platform_sender_id: true, platform_username: true },
        with: { channel: { columns: { id: true, platform: true, display_name: true } } },
      },
      tags: { columns: {}, with: { tag: { columns: { id: true, name: true, color: true } } } },
    },
  });

  if (!contact) return ApiErrors.notFound();

  const [conversationCount, enrollmentCount] = await Promise.all([
    db.$count(conversations, eq(conversations.contact_id, contactId)),
    db.$count(sequenceEnrollments, eq(sequenceEnrollments.contact_id, contactId)),
  ]);

  return ok({ ...contact, _count: { conversations: conversationCount, sequence_enrollments: enrollmentCount } });
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
  const existing = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const [updated] = await db
    .update(contacts)
    .set(parsed.data)
    .where(eq(contacts.id, contactId))
    .returning({
      id: contacts.id,
      display_name: contacts.display_name,
      email: contacts.email,
      is_subscribed: contacts.is_subscribed,
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
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
    columns: { id: true },
    with: { contact_channels: { columns: { platform_sender_id: true } } },
  });
  if (!contact) return ApiErrors.notFound("Contact");

  // CommentLog isn't FK-linked to Contact (author_id is a platform id), so the
  // cascade doesn't reach it — erase it explicitly, workspace-scoped.
  const senderIds = contact.contact_channels.map((cc) => cc.platform_sender_id);
  if (senderIds.length > 0) {
    await db
      .delete(commentLogs)
      .where(and(eq(commentLogs.workspace_id, auth.workspaceId), inArray(commentLogs.author_id, senderIds)));
  }

  // Cascade removes ContactChannel, Conversations + Messages, enrollments,
  // pending approvals and broadcast recipients ( foreign keys).
  await db.delete(contacts).where(eq(contacts.id, contactId));

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ContactErased,
    targetType: "contact",
    targetId: contactId,
  });

  return noContent();
}
