import { eq, desc } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { auditLogs } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// GET /api/v1/audit-log — workspace-scoped audit trail, newest first (AUDIT1).
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "settings:read").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  const logs = await db.query.auditLogs.findMany({
    where: eq(auditLogs.workspace_id, auth.workspaceId),
    orderBy: desc(auditLogs.created_at),
    limit,
    offset,
    columns: {
      id: true,
      actor_type: true,
      actor_id: true,
      action: true,
      target_type: true,
      target_id: true,
      metadata: true,
      created_at: true,
    },
  });

  return ok(logs, { limit, offset });
}
