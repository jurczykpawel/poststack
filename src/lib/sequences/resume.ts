import { and, eq, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { sequenceEnrollments } from "@/db/schema";
import { addJobTx } from "@/lib/queue/client";

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
