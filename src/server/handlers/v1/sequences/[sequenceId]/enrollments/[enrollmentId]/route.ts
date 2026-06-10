import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { sequences, sequenceEnrollments } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// DELETE /api/v1/sequences/:sequenceId/enrollments/:enrollmentId — cancel an in-flight enrollment.
//
// Stopping a drip the operator started by mistake had no path: re-enrollment is blocked by the
// unique index, unsubscribe only suppresses sends while the cursor still advances, and pause just
// defers — the only "stop" was deleting the whole sequence. This cancels a single
// enrollment by flipping it to `cancelled`; the sequence-step worker already no-ops a non-active
// enrollment, and the CAS on `status = 'active'` makes the transition race-safe. It also unblocks the
// channel-disconnect flow, whose 409 instructs the operator to cancel enrollments first.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string; enrollmentId: string }> }
) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId, enrollmentId } = await params;

  // Tenant scope: the enrollment must belong to a sequence in this workspace.
  const sequence = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!sequence) return ApiErrors.notFound();

  // Cancel only an active enrollment (CAS); the worker no-ops anything non-active.
  const [cancelled] = await db
    .update(sequenceEnrollments)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(sequenceEnrollments.id, enrollmentId),
        eq(sequenceEnrollments.sequence_id, sequenceId),
        eq(sequenceEnrollments.status, "active"),
      ),
    )
    .returning({ id: sequenceEnrollments.id, status: sequenceEnrollments.status });
  if (cancelled) return ok(cancelled);

  // Not active: either it doesn't exist (404) or it's already terminal — return its current state
  // idempotently (a repeat cancel, or cancelling an already completed/cancelled enrollment).
  const existing = await db.query.sequenceEnrollments.findFirst({
    where: and(eq(sequenceEnrollments.id, enrollmentId), eq(sequenceEnrollments.sequence_id, sequenceId)),
    columns: { id: true, status: true },
  });
  if (!existing) return ApiErrors.notFound();
  return ok(existing);
}
