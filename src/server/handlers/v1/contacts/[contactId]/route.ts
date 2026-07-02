import { and, eq, or, inArray, sql } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db, isForeignKeyViolation } from "@/lib/db";
import { contacts, commentLogs, conversations, sequenceEnrollments, webhookEvents, tags, contactTags } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { emitEvent } from "@/lib/events";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/contacts/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { contactId } = await params;
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
    columns: {
      id: true,
      display_name: true,
      email: true,
      phone: true,
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
  phone: z.string().min(1).max(40).nullable().optional(),
  is_subscribed: z.boolean().optional(),
  // Full replacement of the contact's tag set. Documented in the OpenAPI spec, so it must actually
  // be applied (not silently dropped); ids from another workspace are ignored, not assigned.
  tag_ids: z.array(z.string().uuid()).max(100).optional(),
});

// PATCH /api/v1/contacts/:id
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> }
) {
  const auth = await authenticateWithScope(request, "contacts:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("contacts_crm");
  if (gate) return gate;

  const { contactId } = await params;
  const existing = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  const { tag_ids, ...fields } = parsed.data;
  const returnCols = {
    id: contacts.id,
    display_name: contacts.display_name,
    email: contacts.email,
    phone: contacts.phone,
    is_subscribed: contacts.is_subscribed,
  };

  // Scalar field update + tag-set sync in ONE transaction so a partial update can't leave the
  // contact and its tags inconsistent.
  let updated;
  try {
    updated = await db.transaction(async (tx) => {
      let row;
      if (Object.keys(fields).length > 0) {
        // workspace_id alongside the PK: defense-in-depth so the update stays tenant-scoped even
        // if it ever drifts from the ownership precheck above.
        [row] = await tx
          .update(contacts)
          .set(fields)
          .where(and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)))
          .returning(returnCols);
      } else {
        // tag_ids-only PATCH: nothing to update on the row, just read it back for the response.
        row = await tx.query.contacts.findFirst({
          where: and(eq(contacts.id, contactId), eq(contacts.workspace_id, auth.workspaceId)),
          columns: { id: true, display_name: true, email: true, phone: true, is_subscribed: true },
        });
      }

      if (tag_ids) {
        // Only tags that belong to THIS workspace are assignable — a foreign-workspace id is
        // dropped, never assigned cross-tenant. The select distinct-ifies, so insert can't hit PK.
        const validIds = tag_ids.length
          ? (
              await tx
                .select({ id: tags.id })
                .from(tags)
                .where(and(inArray(tags.id, tag_ids), eq(tags.workspace_id, auth.workspaceId)))
            ).map((t) => t.id)
          : [];
        await tx.delete(contactTags).where(eq(contactTags.contact_id, contactId));
        if (validIds.length > 0) {
          await tx.insert(contactTags).values(validIds.map((tag_id) => ({ contact_id: contactId, tag_id })));
        }
      }

      // Fire contact.updated when the PATCH actually changed something (scalar fields or the tag set),
      // in-tx so the WHOUT1 fan-out commits atomically. Skip a no-op PATCH ({}), which mutates nothing.
      if (row && (Object.keys(fields).length > 0 || tag_ids !== undefined)) {
        await emitEvent(tx, auth.workspaceId, "contact.updated", { type: "contact", id: contactId });
      }

      return row;
    });
  } catch (err) {
    // The ownership precheck runs outside this transaction, so a concurrent erasure of the contact
    // (GDPR) between the check and the contactTags insert surfaces as an FK violation. Map it to a
    // clean 404 rather than an uncaught 500.
    if (isForeignKeyViolation(err)) return ApiErrors.notFound();
    throw err;
  }

  // The row vanished between the precheck and the (field-less) read inside the tx → 404.
  if (!updated) return ApiErrors.notFound();
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
    // The webhook_events log stores the PSID in BOTH directions (sender_id for the contact's
    // inbound events, recipient_id for echo events where the page is the sender and the contact is
    // the recipient) plus the full message text in `raw`. Its channel FK is ON DELETE SET NULL, so
    // a table cascade never reaches it → without this the PSID + conversation content would outlive
    // the contact. Scrub by the SAME (channel, psid) pairs as the comment-log delete (a platform
    // sender id is NOT globally unique across channels — e.g. a Telegram chat id is shared across
    // workspaces — so matching on the id alone would wipe another workspace's log + dedup claims).
    const evtPairs = contact.contact_channels.flatMap((cc) => [
      and(eq(webhookEvents.channel_id, cc.channel_id), eq(webhookEvents.sender_id, cc.platform_sender_id)),
      and(eq(webhookEvents.channel_id, cc.channel_id), eq(webhookEvents.recipient_id, cc.platform_sender_id)),
    ]);
    if (evtPairs.length > 0) {
      await tx.delete(webhookEvents).where(or(...evtPairs));
    }
    // Cascade removes ContactChannel, Conversations + Messages, enrollments, pending
    // approvals, broadcast recipients and outbound_deliveries (via foreign keys).
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
