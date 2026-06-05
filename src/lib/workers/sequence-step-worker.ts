import type { JobHelpers } from "graphile-worker";
import type { SequenceStepJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { addJob } from "@/lib/queue/client";

interface SequenceStep {
  type: "message" | "delay";
  content?: string;
  delay_minutes?: number;
}

/**
 * Execute one step of a sequence enrollment.
 *
 * 1. Load enrollment + sequence steps
 * 2. If current step is a message: send it
 * 3. If current step is a delay: this job fires after the delay, so advance
 * 4. Advance to next step (scheduling delay if next is a delay step)
 * 5. If no more steps: mark enrollment as completed
 */
export async function processSequenceStep(
  payload: SequenceStepJob,
  helpers: JobHelpers,
): Promise<void> {
  const { enrollmentId } = payload;

  const enrollment = await prisma.sequenceEnrollment.findUnique({
    where: { id: enrollmentId },
    select: {
      id: true,
      status: true,
      current_step_index: true,
      contact_id: true,
      channel_id: true,
      sequence: {
        select: { id: true, steps: true },
      },
      contact: {
        select: {
          contact_channels: {
            where: { channel_id: { not: undefined } },
            select: { platform_sender_id: true, channel_id: true },
          },
        },
      },
    },
  });

  if (!enrollment || enrollment.status !== "active") {
    helpers.logger.info(`Enrollment ${enrollmentId} not found or not active, skipping`);
    return;
  }

  const steps = enrollment.sequence.steps as unknown as SequenceStep[];
  const stepIndex = enrollment.current_step_index;

  if (stepIndex >= steps.length) {
    // No more steps — complete
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "completed", completed_at: new Date() },
    });
    return;
  }

  const step = steps[stepIndex];

  if (step.type === "delay") {
    // Delay step: wait, then advance and schedule next
    const delayMs = (step.delay_minutes ?? 0) * 60 * 1000;
    const nextStepIndex = stepIndex + 1;

    if (nextStepIndex >= steps.length) {
      await prisma.sequenceEnrollment.update({
        where: { id: enrollmentId },
        data: { status: "completed", completed_at: new Date(), current_step_index: nextStepIndex },
      });
      return;
    }

    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { current_step_index: nextStepIndex, next_step_at: new Date(Date.now() + delayMs) },
    });

    await addJob("sequence-step", { enrollmentId }, { delayMs });
    return;
  }

  if (step.type === "message" && step.content) {
    const conversation = await prisma.conversation.findFirst({
      where: { contact_id: enrollment.contact_id, channel_id: enrollment.channel_id },
      select: { id: true },
    });

    const contactChannel = enrollment.contact.contact_channels.find(
      (cc) => cc.channel_id === enrollment.channel_id
    );

    if (conversation && contactChannel) {
      await addJob("outgoing-message", {
        channelId: enrollment.channel_id,
        conversationId: conversation.id,
        contactId: enrollment.contact_id,
        recipientPlatformId: contactChannel.platform_sender_id,
        content: { text: step.content },
      });
    } else {
      helpers.logger.info(`No conversation/contactChannel for enrollment ${enrollmentId}, skipping`);
    }
  }

  // Advance to next step immediately (no delay for message steps)
  const nextStepIndex = stepIndex + 1;

  if (nextStepIndex >= steps.length) {
    await prisma.sequenceEnrollment.update({
      where: { id: enrollmentId },
      data: { status: "completed", completed_at: new Date(), current_step_index: nextStepIndex },
    });
    return;
  }

  await prisma.sequenceEnrollment.update({
    where: { id: enrollmentId },
    data: { current_step_index: nextStepIndex, next_step_at: new Date() },
  });

  await addJob("sequence-step", { enrollmentId });
}
