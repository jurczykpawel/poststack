import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, workspace_id: auth.workspaceId, status: "active" },
    select: { id: true, steps: true },
  });
  if (!sequence) return ApiErrors.notFound("Sequence");

  const body = await request.json().catch(() => ({}));
  const parsed = enrollSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  // Verify contact and channel belong to this workspace
  const [contact, channel] = await Promise.all([
    prisma.contact.findFirst({
      where: { id: parsed.data.contact_id, workspace_id: auth.workspaceId },
      select: { id: true },
    }),
    prisma.channel.findFirst({
      where: { id: parsed.data.channel_id, workspace_id: auth.workspaceId },
      select: { id: true },
    }),
  ]);
  if (!contact) return ApiErrors.notFound("Contact");
  if (!channel) return ApiErrors.notFound("Channel");

  // Verify the contact has a platform identity on this channel
  const contactChannel = await prisma.contactChannel.findFirst({
    where: { contact_id: parsed.data.contact_id, channel_id: parsed.data.channel_id },
    select: { id: true },
  });
  if (!contactChannel) {
    return ApiErrors.badRequest("Contact has no platform identity on this channel");
  }

  // Create enrollment (skip if already enrolled and active)
  const existing = await prisma.sequenceEnrollment.findFirst({
    where: {
      sequence_id: sequenceId,
      contact_id: parsed.data.contact_id,
      status: "active",
    },
    select: { id: true },
  });
  if (existing) {
    return ApiErrors.conflict("Contact is already enrolled in this sequence");
  }

  const steps = sequence.steps as Array<{ type: string; delay_minutes?: number }>;
  const firstStep = steps[0];
  const delay =
    firstStep?.type === "delay" ? (firstStep.delay_minutes ?? 0) * 60 * 1000 : 0;

  const enrollment = await prisma.sequenceEnrollment.create({
    data: {
      sequence_id: sequenceId,
      contact_id: parsed.data.contact_id,
      channel_id: parsed.data.channel_id,
      current_step_index: 0,
      next_step_at: new Date(Date.now() + delay),
    },
  });

  // Schedule the first step
  await addJob("sequence-step", { enrollmentId: enrollment.id }, { delayMs: delay });

  return created(enrollment);
}
