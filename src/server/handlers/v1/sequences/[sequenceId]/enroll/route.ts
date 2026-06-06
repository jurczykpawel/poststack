import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { sequences, sequenceEnrollments, contacts, channels, contactChannels } from "@/db/schema";
import { created, ApiErrors } from "@/lib/api/response";
import { addJob } from "@/lib/queue/client";
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

  // Create enrollment (skip if already enrolled and active)
  const existing = await db.query.sequenceEnrollments.findFirst({
    where: and(
      eq(sequenceEnrollments.sequence_id, sequenceId),
      eq(sequenceEnrollments.contact_id, parsed.data.contact_id),
      eq(sequenceEnrollments.status, "active"),
    ),
    columns: { id: true },
  });
  if (existing) {
    return ApiErrors.conflict("Contact is already enrolled in this sequence");
  }

  const steps = (sequence.steps ?? []) as Array<{ type: string; delay_minutes?: number }>;
  const firstStep = steps[0];
  const delay = firstStep?.type === "delay" ? (firstStep.delay_minutes ?? 0) * 60 * 1000 : 0;

  const [enrollment] = await db
    .insert(sequenceEnrollments)
    .values({
      sequence_id: sequenceId,
      contact_id: parsed.data.contact_id,
      channel_id: parsed.data.channel_id,
      current_step_index: 0,
      next_step_at: new Date(Date.now() + delay),
    })
    .returning();

  // Schedule the first step
  await addJob("sequence-step", { enrollmentId: enrollment.id }, { delayMs: delay });

  return created(enrollment);
}
