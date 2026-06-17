import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db, isUniqueViolation } from "@/lib/db";
import { sequences, sequenceEnrollments, contacts, channels, contactChannels } from "@/db/schema";
import { created, ApiErrors } from "@/lib/api/response";
import { enrollContactInSequence } from "@/lib/sequences/enroll";
import { z } from "zod";

export const runtime = "nodejs";

const enrollSchema = z.object({
  contact_id: z.string().uuid(),
  channel_id: z.string().uuid(),
});

// POST /api/v1/sequences/:id/enroll
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const sequence = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId), eq(sequences.status, "active")),
    columns: { id: true, steps: true },
  });
  if (!sequence) return ApiErrors.notFound("Sequence");

  const body = await request.json().catch(() => ({}));
  const parsed = enrollSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  // Verify contact and channel belong to this workspace
  const [contact, channel] = await Promise.all([
    db.query.contacts.findFirst({
      where: and(eq(contacts.id, parsed.data.contact_id), eq(contacts.workspace_id, auth.workspaceId)),
      columns: { id: true },
    }),
    db.query.channels.findFirst({
      where: and(eq(channels.id, parsed.data.channel_id), eq(channels.workspace_id, auth.workspaceId)),
      columns: { id: true },
    }),
  ]);
  if (!contact) return ApiErrors.notFound("Contact");
  if (!channel) return ApiErrors.notFound("Channel");

  // Verify the contact has a platform identity on this channel
  const contactChannel = await db.query.contactChannels.findFirst({
    where: and(eq(contactChannels.contact_id, parsed.data.contact_id), eq(contactChannels.channel_id, parsed.data.channel_id)),
    columns: { id: true },
  });
  if (!contactChannel) {
    return ApiErrors.badRequest("Contact has no platform identity on this channel");
  }

  // The unique index on (sequence_id, contact_id) is unconditional, so a contact can be
  // enrolled in a sequence at most ONCE ever — including after it completed/was cancelled.
  // Match ANY prior enrollment (not just active) and reject with a clean 409, rather than
  // letting a re-enroll of a completed contact hit the unique constraint as an unhandled
  // 500. Re-running a sequence would be a separate feature (partial-unique index).
  const existing = await db.query.sequenceEnrollments.findFirst({
    where: and(
      eq(sequenceEnrollments.sequence_id, sequenceId),
      eq(sequenceEnrollments.contact_id, parsed.data.contact_id),
    ),
    columns: { id: true },
  });
  if (existing) {
    return ApiErrors.conflict("Contact has already been enrolled in this sequence");
  }

  // Create the enrollment and schedule its first step in ONE transaction (a transactional outbox),
  // via the shared helper — the same enroll logic the rule engine uses for trigger-driven enrollment
  // (SEQTRIGGER1). The helper's `onConflictDoNothing` makes a lost race to the unique (sequence,
  // contact) index return `{enrolled:false}` instead of a 500; surface that as the same clean 409.
  let result;
  try {
    result = await db.transaction((tx) =>
      enrollContactInSequence(tx, { sequence, contactId: parsed.data.contact_id, channelId: parsed.data.channel_id }),
    );
  } catch (err) {
    if (isUniqueViolation(err)) return ApiErrors.conflict("Contact has already been enrolled in this sequence");
    throw err;
  }
  if (!result.enrolled) return ApiErrors.conflict("Contact has already been enrolled in this sequence");

  const enrollment = await db.query.sequenceEnrollments.findFirst({
    where: eq(sequenceEnrollments.id, result.enrollmentId!),
  });
  return created(enrollment);
}
