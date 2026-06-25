import { eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { workspaces } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { MAX_RETENTION_DAYS } from "@/lib/retention";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/workspace — current workspace settings.
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "settings:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, auth.workspaceId),
    columns: { id: true, name: true, message_retention_days: true },
  });
  if (!workspace) return ApiErrors.notFound("Workspace");
  return ok(workspace);
}

const patchSchema = z.object({
  // null = keep messages forever (retention off). Bounded (the dashboard enforces the same ceiling):
  // an unbounded value would push the retention cron's cutoff Date out of range and throw, and the
  // cron loops every workspace — so a huge value here would DoS retention for all tenants.
  message_retention_days: z.number().int().min(1).max(MAX_RETENTION_DAYS).nullable(),
});

// PATCH /api/v1/workspace — update workspace settings (DATA1: retention policy).
export async function PATCH(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error);
  }

  const [updated] = await db
    .update(workspaces)
    .set({ message_retention_days: parsed.data.message_retention_days })
    .where(eq(workspaces.id, auth.workspaceId))
    .returning({ id: workspaces.id, name: workspaces.name, message_retention_days: workspaces.message_retention_days });
  return ok(updated);
}
