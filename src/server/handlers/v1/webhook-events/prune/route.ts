import { authenticateWithScope } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { pruneWorkspaceWebhookEvents, MAX_RETENTION_DAYS } from "@/lib/retention";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

const schema = z.object({
  // Bounded like the message-prune endpoint: an unbounded value pushes the cutoff Date out of
  // range and throws RangeError on toISOString() → 500.
  older_than_days: z.number().int().min(1).max(MAX_RETENTION_DAYS),
});

// POST /api/v1/webhook-events/prune — manually delete this workspace's webhook_events log rows
// older than N days. The log has no auto-TTL (it is the durable inbound-event record); retention is
// owner-driven. Mirrors messages/prune: bounded older_than_days, settings:write scope.
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "settings:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const result = await pruneWorkspaceWebhookEvents(auth.workspaceId, parsed.data.older_than_days);

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.WebhookEventsPruned,
    metadata: { older_than_days: parsed.data.older_than_days, ...result },
  });

  return ok(result);
}
