import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { accountSources } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { proGate } from "@/lib/api/pro-gate";
import { recordAudit, actorFromAuth, AuditAction } from "@/lib/audit";
import { syncAccountSource, markSourceNeedsReauth } from "@/lib/channels/account-source";
import { MetaTokenError } from "@/lib/platforms/meta-token";

export const runtime = "nodejs";

// POST /api/v1/sources/:sourceId/sync — re-enumerate this managed connection now.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  const auth = await authenticateWithScope(request, "sources:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const gate = await proGate("managed_connection");
  if (gate) return gate;

  const { sourceId } = await params;
  const source = await db.query.accountSources.findFirst({
    where: and(eq(accountSources.id, sourceId), eq(accountSources.workspace_id, auth.workspaceId)),
    columns: { id: true },
  });
  if (!source) return ApiErrors.notFound("Source");

  let result;
  try {
    result = await syncAccountSource(sourceId);
  } catch (err) {
    // A dead master surfaces as a specific error; flag the source (cascades to children) and report it.
    const reason = err instanceof Error ? err.message : String(err);
    await markSourceNeedsReauth(sourceId, reason).catch(() => {});
    if (err instanceof MetaTokenError) return ApiErrors.badRequest(reason);
    return ApiErrors.badRequest("Could not sync this connection — re-connect it with a fresh token");
  }

  await recordAudit({
    workspaceId: auth.workspaceId,
    actor: actorFromAuth(auth),
    action: AuditAction.ChannelConnected,
    targetType: "account_source",
    targetId: sourceId,
    metadata: { mode: "managed-sync", connected: result.connected, by_platform: result.byPlatform },
  });

  return ok({ connected: result.connected, by_platform: result.byPlatform });
}
