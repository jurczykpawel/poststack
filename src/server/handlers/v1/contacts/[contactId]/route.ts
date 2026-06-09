import { and, eq, or, sql } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { contacts, commentLogs, conversations, sequenceEnrollments, processedEvents } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

/** Escape SQL LIKE wildcards so an interpolated value matches literally (paired with ESCAPE '\'). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

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
    // workspace_id alongside the PK: defense-in-depth so the update stays tenant-scoped even if
    // it ever drifts from the ownership precheck above.
    .where(and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)))
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
    with: { contact_channels: { columns: { channel_id: true, platform_sender_id: true } } },
  });
  if (!contact) return ApiErrors.notFound("Contact");

  // Erase atomically: the comment-log delete and the cascading contact delete commit
  // together. CommentLog isn't FK-linked to Contact (author_id is a platform id), so the
  // cascade doesn't reach it — erase it explicitly, matching the SAME (channel, sender)
  // pairs as this contact. A platform sender id is NOT globally unique across channels, so
  // matching on the id alone would wipe another contact's logs on a different channel.
  await db.transaction(async (tx) => {
    const pairs = contact.contact_channels.map((cc) =>
      and(eq(commentLogs.channel_id, cc.channel_id), eq(commentLogs.author_id, cc.platform_sender_id)),
    );
    if (pairs.length > 0) {
      await tx.delete(commentLogs).where(and(eq(commentLogs.workspace_id, auth.workspaceId), or(...pairs)));
    }
    // Queued/dead-letter graphile jobs carry the contact's PSID + message text in their
    // payload and aren't reached by any table cascade or TTL prune — scrub them by the
    // contact id (outbound jobs) and platform sender id(s) (inbound jobs) so erasure is
    // complete in the queue too.
    const psids = contact.contact_channels.map((cc) => cc.platform_sender_id);
    const senderClause =
      psids.length > 0
        ? sql`payload->>'senderId' in (${sql.join(psids.map((p) => sql`${p}`), sql`, `)})`
        : sql`false`;
    await tx.execute(
      sql`delete from graphile_worker._private_jobs where payload->>'contactId' = ${contactId} or ${senderClause}`,
    );
    // A reaction event-dedup key embeds the reactor's PSID (`reaction:{channelId}:{psid}:...`)
    // and is never reached by a table cascade or the time-based prune, so without this the PSID
    // outlives the contact. Scrub the keys for this contact's (channel, sender) pairs.
    // The sender id is interpolated into a LIKE pattern, so escape its `\ % _` (today's PSIDs are
    // numeric, but a future platform handle could carry a wildcard and over-delete neighbours) —
    // ESCAPE '\' makes the escaped chars match literally.
    const reactionKeyClauses = contact.contact_channels.map(
      (cc) => sql`${processedEvents.key} like ${`reaction:${cc.channel_id}:${escapeLike(cc.platform_sender_id)}:%`} escape '\\'`,
    );
    if (reactionKeyClauses.length > 0) {
      await tx.delete(processedEvents).where(or(...reactionKeyClauses));
    }
    // Cascade removes ContactChannel, Conversations + Messages, enrollments, pending
    // approvals, broadcast recipients and outbound_deliveries ( +  foreign keys).
    // workspace_id alongside the PK keeps the erase tenant-scoped.
    await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)));
  });

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ContactErased,
    targetType: "contact",
    targetId: contactId,
  });

  return noContent();
}
