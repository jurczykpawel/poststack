import { authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/workspace — current workspace settings.
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "settings:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const workspace = await prisma.workspace.findUnique({
    where: { id: auth.workspaceId },
    select: { id: true, name: true, message_retention_days: true },
  });
  if (!workspace) return ApiErrors.notFound("Workspace");
  return ok(workspace);
}

const patchSchema = z.object({
  // null = keep messages forever (retention off).
  message_retention_days: z.number().int().min(1).nullable(),
});

// PATCH /api/v1/workspace — update workspace settings (DATA1: retention policy).
export async function PATCH(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const updated = await prisma.workspace.update({
    where: { id: auth.workspaceId },
    data: { message_retention_days: parsed.data.message_retention_days },
    select: { id: true, name: true, message_retention_days: true },
  });
  return ok(updated);
}
