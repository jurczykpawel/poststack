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
        z.object({ type: z.literal("delay"), delay_minutes: z.number().int().min(1) }),
      ])
    )
    .min(1)
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
  const result = await db
    .delete(sequences)
    .where(and(eq(sequences.id, sequenceId), eq(sequences.workspace_id, auth.workspaceId)));
  if ((result.rowCount ?? 0) === 0) return ApiErrors.notFound();
  return noContent();
}
