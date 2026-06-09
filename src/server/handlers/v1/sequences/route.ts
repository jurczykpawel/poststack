import { eq, desc } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { sequences, sequenceEnrollments } from "@/db/schema";
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
    // Capped at 2 weeks: an unbounded delay parks next_step_at effectively forever.
    delay_minutes: z.number().int().min(1).max(20160),
  }),
]);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  steps: z.array(stepSchema).min(1).max(50),
});

// GET /api/v1/sequences
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "sequences:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const rows = await db.query.sequences.findMany({
    where: eq(sequences.workspace_id, auth.workspaceId),
    orderBy: desc(sequences.created_at),
    columns: { id: true, name: true, description: true, status: true, steps: true, created_at: true },
  });

  const withCounts = await Promise.all(
    rows.map(async (seq) => ({
      ...seq,
      _count: { enrollments: await db.$count(sequenceEnrollments, eq(sequenceEnrollments.sequence_id, seq.id)) },
    })),
  );

  return ok(withCounts);
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

  const [sequence] = await db
    .insert(sequences)
    .values({
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      steps: parsed.data.steps,
    })
    .returning();

  return created(sequence);
}
