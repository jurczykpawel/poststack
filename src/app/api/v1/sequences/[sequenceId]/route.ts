import { authenticate } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ok, noContent, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/sequences/:id
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, workspace_id: auth.workspaceId },
    include: { _count: { select: { enrollments: true } } },
  });
  if (!sequence) return ApiErrors.notFound();
  return ok(sequence);
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
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const existing = await prisma.sequence.findFirst({
    where: { id: sequenceId, workspace_id: auth.workspaceId },
    select: { id: true },
  });
  if (!existing) return ApiErrors.notFound();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { steps, ...rest } = parsed.data;
  const updated = await prisma.sequence.update({
    where: { id: sequenceId },
    data: {
      ...rest,
      ...(steps !== undefined ? { steps: steps as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  return ok(updated);
}

// DELETE /api/v1/sequences/:id
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sequenceId: string }> }
) {
  const auth = await authenticate(request).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sequenceId } = await params;
  const result = await prisma.sequence.deleteMany({
    where: { id: sequenceId, workspace_id: auth.workspaceId },
  });
  if (result.count === 0) return ApiErrors.notFound();
  return noContent();
}
