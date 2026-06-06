import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

const stepSchema = z.union([
  z.object({
    type: z.literal("message"),
    content: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("delay"),
    delay_minutes: z.number().int().min(1),
  }),
]);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  steps: z.array(stepSchema).min(1),
});

// GET /api/v1/sequences
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const sequences = await prisma.sequence.findMany({
    where: { workspace_id: auth.workspaceId },
    orderBy: { created_at: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      steps: true,
      created_at: true,
      _count: { select: { enrollments: true } },
    },
  });

  return ok(sequences);
}

// POST /api/v1/sequences
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "sequences:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const sequence = await prisma.sequence.create({
    data: {
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      steps: parsed.data.steps,
    },
  });

  return created(sequence);
}
