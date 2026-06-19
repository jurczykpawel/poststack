import type { JobHelpers } from "graphile-worker";
import { and, eq } from "drizzle-orm";
import type { SequenceStepJob } from "@/lib/queue/types";
import { db } from "@/lib/db";
import { sequenceEnrollments, conversations, contactChannels, contacts, channels } from "@/db/schema";
import { addJob, addJobTx } from "@/lib/queue/client";

interface SequenceStep {
  type: "message" | "delay";
  content?: string;
  delay_minutes?: number;
}

/** While a conversation's automation is paused, a due drip step is re-checked (not advanced)
 *  on this cadence, so it resumes from the right place once the operator un-pauses. */
const PAUSE_RECHECK_MS = 30 * 60 * 1000;

/**
 * Execute one step of a sequence enrollment.
 *
 * The enrollment is driven from its immutable `steps_snapshot` (pinned at enrollment time),
 * so editing the live sequence definition can't change what an in-flight enrollment delivers
 *. The cursor advance and the queue hand-offs (the step's outbound message and the
 * next step) commit in ONE transaction, gated by a conditional `WHERE current_step_index =
 * expected AND status = 'active'`: a crash mid-step rolls everything back so a retry
 * re-runs the step exactly once, and the deterministic per-step job keys mean even a duplicate
 * delivery can't double-send or skip the schedule.
 */
export async function processSequenceStep(
  payload: SequenceStepJob,
  helpers: JobHelpers,
): Promise<void> {
  const { enrollmentId } = payload;

  const enrollment = await db.query.sequenceEnrollments.findFirst({
    where: eq(sequenceEnrollments.id, enrollmentId),
    columns: { id: true, status: true, current_step_index: true, contact_id: true, channel_id: true, steps_snapshot: true },
  });

  if (!enrollment || enrollment.status !== "active") {
    helpers.logger.info(`Enrollment ${enrollmentId} not found or not active, skipping`);
    return;
  }

  const steps = (enrollment.steps_snapshot ?? []) as unknown as SequenceStep[];
  const stepIndex = enrollment.current_step_index;

  // Past the end → complete (conditionally, so a concurrent/late retry is a no-op).
  if (stepIndex >= steps.length) {
    await db
      .update(sequenceEnrollments)
      .set({ status: "completed", completed_at: new Date() })
      .where(and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.status, "active")));
    return;
  }

  const step = steps[stepIndex];
  const delayMs = step.type === "delay" ? (step.delay_minutes ?? 0) * 60 * 1000 : 0;
  const isMessage = step.type === "message" && !!step.content;
  const nextStepIndex = stepIndex + 1;
  const isLast = nextStepIndex >= steps.length;

  // Per-conversation kill switch — applies to EVERY step type. If an operator paused
  // automation (e.g. a human took over), HOLD the enrollment: don't send AND don't advance the
  // cursor, for a `delay` step just as much as a `message` step — otherwise the delay "counts down"
  // during the pause and the enrollment marches on. Re-check later so it resumes from the same step
  // once un-paused. The lookup runs for every step type, so this check sits before the message
  // branch (a delay step has no conversation only if none exists yet — then it isn't paused).
  const conversation = await db.query.conversations.findFirst({
    where: and(eq(conversations.contact_id, enrollment.contact_id), eq(conversations.channel_id, enrollment.channel_id)),
    columns: { id: true, is_automation_paused: true },
  });
  // A manually paused CHANNEL holds the enrollment exactly like a paused conversation: if
  // the cursor advanced during a channel pause, the step's message would be parked `held` and — for
  // a pause longer than the drain window — silently expire (lost step). Defer instead, so it resumes
  // from the same step once the channel is un-paused, matching the conversation-pause behaviour.
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, enrollment.channel_id),
    columns: { status: true },
  });
  if (conversation?.is_automation_paused || channel?.status === "paused") {
    await addJob(
      "sequence-step",
      { enrollmentId },
      { jobKey: `seq-step-paused:${enrollmentId}:${stepIndex}`, delayMs: PAUSE_RECHECK_MS },
    );
    helpers.logger.info(`Automation paused (conversation or channel) for enrollment ${enrollmentId}, deferring step ${stepIndex}`);
    return;
  }

  // A message step needs a conversation + the contact's identity on the channel to address the
  // send. A missing pair just advances without sending. Consent gate: an unsubscribed contact is
  // not sent the step — the enrollment still advances so it resumes naturally if they re-subscribe
  // before a later step.
  let outgoing: { conversationId: string; recipientPlatformId: string } | null = null;
  if (isMessage) {
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, enrollment.contact_id),
      columns: { is_subscribed: true },
    });
    if (!contact?.is_subscribed) {
      helpers.logger.info(`Contact ${enrollment.contact_id} is unsubscribed, advancing sequence without sending`);
    } else {
      const cc = await db.query.contactChannels.findFirst({
        where: and(eq(contactChannels.contact_id, enrollment.contact_id), eq(contactChannels.channel_id, enrollment.channel_id)),
        columns: { platform_sender_id: true },
      });
      if (conversation && cc) {
        outgoing = { conversationId: conversation.id, recipientPlatformId: cc.platform_sender_id };
      } else {
        helpers.logger.info(`No conversation/contactChannel for enrollment ${enrollmentId}, advancing without sending`);
      }
    }
  }

  await db.transaction(async (tx) => {
    // Conditional advance: only fire the side effects if THIS attempt is the one that moves the
    // cursor off `stepIndex` while still active. A retry whose prior attempt already advanced
    // finds no row and does nothing.
    const advanced = await tx
      .update(sequenceEnrollments)
      .set(
        isLast
          ? { current_step_index: nextStepIndex, status: "completed", completed_at: new Date(), next_step_at: null }
          : { current_step_index: nextStepIndex, next_step_at: new Date(Date.now() + delayMs) },
      )
      .where(
        and(
          eq(sequenceEnrollments.id, enrollmentId),
          eq(sequenceEnrollments.current_step_index, stepIndex),
          eq(sequenceEnrollments.status, "active"),
        ),
      )
      .returning({ id: sequenceEnrollments.id });
    if (advanced.length === 0) return;

    if (outgoing) {
      // TIMING2: the FIRST sequence message is measurable only when it is step 0 AND the step-0 job
      // carried the trigger stamp (enroll forwards it only to step 0). A delay-first sequence reaches
      // its first message at step >= 1, so it is never measured — matching the spec.
      const measurable = stepIndex === 0 && !!payload.triggerEventId;
      await addJobTx(
        tx,
        "outgoing-message",
        {
          channelId: enrollment.channel_id,
          conversationId: outgoing.conversationId,
          contactId: enrollment.contact_id,
          recipientPlatformId: outgoing.recipientPlatformId,
          content: { text: step.content },
          idempotencyKey: `seq-msg:${enrollmentId}:${stepIndex}`,
          ...(measurable
            ? { triggerEventId: payload.triggerEventId, triggerReceivedAt: payload.triggerReceivedAt, measurable: true }
            : {}),
        },
        { jobKey: `seq-msg:${enrollmentId}:${stepIndex}` },
      );
    }

    // The next step's job deliberately omits the trigger stamp — only the step-0 job (scheduled at
    // enrollment) carries it, so only the first sequence message can ever be measured.

    if (!isLast) {
      await addJobTx(
        tx,
        "sequence-step",
        { enrollmentId },
        { jobKey: `seq-step:${enrollmentId}:${nextStepIndex}`, runAt: new Date(Date.now() + delayMs) },
      );
    }
  });
}
