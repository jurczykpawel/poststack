import { db } from "@/lib/db";
import { sequenceEnrollments } from "@/db/schema";
import { addJobTx } from "@/lib/queue/client";

/** A Drizzle db handle or an open transaction. */
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The minimal sequence shape an enrollment needs: its id and its (immutable-at-enroll) steps. */
export interface EnrollableSequence {
  id: string;
  steps: unknown;
}

export interface EnrollResult {
  /** True when a fresh enrollment row was created (and its first step scheduled); false when the
   *  contact was already enrolled in this sequence (the unique (sequence, contact) index held). */
  enrolled: boolean;
  enrollmentId?: string;
}

/**
 * Enroll a contact into a sequence and schedule its first step, in the caller's transaction (a
 * transactional outbox — the enrollment row and the `sequence-step` job commit together, so a
 * failed enqueue can't strand an active enrollment with no first step queued).
 *
 * Idempotent by construction: the unconditional unique index on (sequence_id, contact_id) means a
 * contact is enrolled in a sequence AT MOST ONCE ever. A second enroll (a redelivered trigger, a
 * re-fired rule) is `onConflictDoNothing` → returns `{ enrolled: false }` and schedules nothing,
 * so it never duplicates or restarts a running/completed drip. The enrollment pins an immutable
 * snapshot of the steps so a later edit of the sequence definition can't change what it delivers.
 */
export async function enrollContactInSequence(
  tx: Executor,
  opts: { sequence: EnrollableSequence; contactId: string; channelId: string; now?: Date },
): Promise<EnrollResult> {
  const now = opts.now ?? new Date();
  const steps = (opts.sequence.steps ?? []) as Array<{ type?: string; delay_minutes?: number }>;
  const firstStep = steps[0];
  // A leading `delay` step defers the first send by its minutes; otherwise the first message goes now.
  const delayMs = firstStep?.type === "delay" ? (firstStep.delay_minutes ?? 0) * 60 * 1000 : 0;
  const runAt = new Date(now.getTime() + delayMs);

  const [row] = await tx
    .insert(sequenceEnrollments)
    .values({
      sequence_id: opts.sequence.id,
      contact_id: opts.contactId,
      channel_id: opts.channelId,
      current_step_index: 0,
      steps_snapshot: opts.sequence.steps,
      next_step_at: runAt,
    })
    .onConflictDoNothing({ target: [sequenceEnrollments.sequence_id, sequenceEnrollments.contact_id] })
    .returning({ id: sequenceEnrollments.id });

  // Conflict (already enrolled) → no row returned → schedule nothing.
  if (!row) return { enrolled: false };

  await addJobTx(tx, "sequence-step", { enrollmentId: row.id }, { jobKey: `seq-step:${row.id}:0`, runAt });
  return { enrolled: true, enrollmentId: row.id };
}
