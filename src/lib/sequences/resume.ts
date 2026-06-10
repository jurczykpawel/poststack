import { and, asc, eq, gt, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { sequenceEnrollments } from "@/db/schema";
import { addJob, addJobTx } from "@/lib/queue/client";

/** A Drizzle db handle or an open transaction. */
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Immediately re-enqueue the next step for active drip enrollments on a channel (optionally narrowed
 * to one contact) whose step is already DUE — i.e. was deferred while a conversation/channel was
 * paused. Un-pausing then resumes the drip at once instead of waiting up to the 30-minute paused-poll
 * cadence; the poll remains a fallback.
 *
 * Only enrollments with `next_step_at <= now` are touched, so a not-yet-due step (which has a
 * scheduled `seq-step:` job) is never processed early. The worker's CAS guard (status='active' +
 * current_step_index) and the deterministic `seq-resume:` jobKey make the extra enqueue a safe no-op
 * against the pending poll. Enqueued via the caller's transaction so it commits with the un-pause.
 */
export async function resumeDueEnrollments(
  tx: Executor,
  opts: { channelId: string; contactId?: string; now?: Date },
): Promise<void> {
  const now = opts.now ?? new Date();
  const rows = await tx.query.sequenceEnrollments.findMany({
    where: and(
      eq(sequenceEnrollments.channel_id, opts.channelId),
      eq(sequenceEnrollments.status, "active"),
      lte(sequenceEnrollments.next_step_at, now),
      ...(opts.contactId ? [eq(sequenceEnrollments.contact_id, opts.contactId)] : []),
    ),
    columns: { id: true },
  });
  for (const r of rows) {
    await addJobTx(tx, "sequence-step", { enrollmentId: r.id }, { jobKey: `seq-resume:${r.id}` });
  }
}

/**
 * How many active+due enrollments to load per round when resuming a WHOLE channel. After a long
 * pause a high-volume channel (a lead magnet enrolling everyone) can have tens of thousands of
 * active enrollments; loading them all at once — and fanning out an add_job per row INSIDE the
 * unpause transaction — risked OOM + a multi-second tx holding the channel row write-locked, timing
 * out the PATCH. We keyset-page by `id` like the drain, so memory stays flat.
 */
export const RESUME_BATCH_SIZE = 300;
/** Spacing between resumed steps, so a large backlog doesn't burst the send pipeline (mirrors drain). */
const RESUME_STAGGER_MS = 250;

/**
 * Resume EVERY active drip enrollment on a channel whose step is already due — run as a background
 * job (enqueued by channel-unpause via the transactional outbox) so the unpause request itself stays
 * O(1) instead of fanning out an enqueue per enrollment in its own transaction. Keyset-paged
 * by `id` (memory flat across batches); per-step enqueue is staggered to avoid a send burst. The
 * deterministic `seq-resume:${id}` jobKey + the step worker's CAS guard make every enqueue an
 * idempotent no-op against the paused-poll and the conversation-level resume, so batching is safe.
 */
export async function resumeChannelEnrollments(
  channelId: string,
  now: Date = new Date(),
): Promise<{ resumed: number }> {
  let resumed = 0;
  let cursorId: string | null = null;
  for (;;) {
    const batch: { id: string }[] = await db
      .select({ id: sequenceEnrollments.id })
      .from(sequenceEnrollments)
      .where(
        and(
          eq(sequenceEnrollments.channel_id, channelId),
          eq(sequenceEnrollments.status, "active"),
          lte(sequenceEnrollments.next_step_at, now),
          cursorId ? gt(sequenceEnrollments.id, cursorId) : undefined,
        ),
      )
      .orderBy(asc(sequenceEnrollments.id))
      .limit(RESUME_BATCH_SIZE);
    if (batch.length === 0) break;
    for (const r of batch) {
      await addJob("sequence-step", { enrollmentId: r.id }, { jobKey: `seq-resume:${r.id}`, delayMs: resumed * RESUME_STAGGER_MS });
      resumed++;
    }
    if (batch.length < RESUME_BATCH_SIZE) break;
    cursorId = batch[batch.length - 1].id;
  }
  return { resumed };
}
