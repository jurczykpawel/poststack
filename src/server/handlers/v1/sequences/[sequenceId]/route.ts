import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { sequences, sequenceEnrollments } from "@/db/schema";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/sequences/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticateWithScope(request, "sequences:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const sequence = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)),
  });
  if (!sequence) return ApiErrors.notFound();

  const enrollments = await db.$count(sequenceEnrollments, eq(sequenceEnrollments.sequence_id, sequenceId));
  return ok({ ...sequence, _count: { enrollments } });
}

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  steps: z
    .array(
      z.union([
        z.object({ type: z.literal("message"), content: z.string().min(1).max(2000) }),
        z.object({ type: z.literal("delay"), delay_minutes: z.number().int().min(1).max(20160) }),
      ])
    )
    .min(1)
    .max(50)
    .optional(),
});

// PATCH /api/v1/sequences/:id
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const existing = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }
  // An empty body would reach `.set({})` → Drizzle "No values to set" → 500; return a 422 validation
  // error instead (consistent with this endpoint's other bad-body responses).
  if (Object.keys(parsed.data).length === 0) {
    return ApiErrors.validationError({ _errors: ["No fields to update"] });
  }

  const [updated] = await db
    .update(sequences)
    .set(parsed.data)
    // Scope the write by workspace too (consistent with DELETE), not just the prior findFirst.
    .where(and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)))
    .returning();
  return ok(updated);
}

// DELETE /api/v1/sequences/:id
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const existing = await db.query.sequences.findFirst({
    where: and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  // sequence_enrollments.sequence_id is ON DELETE cascade, so a bare delete would silently destroy
  // in-flight drips with no confirmation — asymmetric with channel-delete, which RESTRICTs with a
  // 409. Block it the same way; the operator archives the sequence (keeps definition + enrollments)
  // or cancels the enrollments first (, complements the cancel route in ).
  const activeEnrollment = await db.query.sequenceEnrollments.findFirst({
    where: and(eq(sequenceEnrollments.sequence_id, sequenceId), eq(sequenceEnrollments.status, "active")),
    columns: { id: true },
  });
  if (activeEnrollment) {
    return ApiErrors.conflict("Sequence has active enrollments — archive it or cancel the enrollments first");
  }

  const result = await db
    .delete(sequences)
    .where(and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();
  return noContent();
}
