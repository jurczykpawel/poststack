import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountSources } from "@/db/schema";
import { ApiErrors } from "@/lib/api/response";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";

export const runtime = "nodejs";

// DELETE /api/v1/sources/:sourceId — remove a managed connection. The FK is onDelete:set null, so
// the derived channels (and their data) survive as standalone channels; only the master link is cut.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  const auth = await authenticateWithScope(request, "sources:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { sourceId } = await params;
  const deleted = await db
    .delete(accountSources)
    .where(and(eq(accountSources.id, sourceId), eq(accountSources.workspace_id, auth.workspaceId)))
    .returning({ id: accountSources.id });
  if (deleted.length === 0) return ApiErrors.notFound("Source");

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelDisconnected,
    targetType: "account_source",
    targetId: sourceId,
  });

  return new Response(null, { status: 204 });
}
