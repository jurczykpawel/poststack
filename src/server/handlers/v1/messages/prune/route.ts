import { authenticateWithScope } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { pruneWorkspaceMessages } from "@/lib/retention";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  older_than_days: z.number().int().min(1),
});

// POST /api/v1/messages/prune — manually delete this workspace's messages
// older than N days (DATA1). Held/pending messages are never removed.
// Retention is a settings-domain action (it mirrors the workspace's
// message_retention_days, which is governed by settings:write).
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const result = await pruneWorkspaceMessages(auth.workspaceId, parsed.data.older_than_days);

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.MessagesPruned,
    metadata: { older_than_days: parsed.data.older_than_days, ...result },
  });

  return ok(result);
}
