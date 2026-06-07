import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { pendingApprovals } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";

export const runtime = "nodejs";

// POST /api/v1/approvals/:approvalId/reject — discard the parked reply (no send)
export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { approvalId } = await params;
  const resolvedBy = auth.userId.startsWith("api-key:") ? null : auth.userId;

  const [row] = await db
    .update(pendingApprovals)
    .set({ status: "rejected", resolved_at: new Date(), resolved_by: resolvedBy })
    .where(
      and(
        eq(pendingApprovals.id, approvalId),
        eq(pendingApprovals.workspace_id, auth.workspaceId),
        eq(pendingApprovals.status, "pending"),
      ),
    )
    .returning();

  if (!row) {
    const existing = await db.query.pendingApprovals.findFirst({
      where: and(eq(pendingApprovals.id, approvalId), eq(pendingApprovals.workspace_id, auth.workspaceId)),
      columns: { id: true, status: true },
    });
    if (!existing) return ApiErrors.notFound("Approval");
    return ApiErrors.conflict(`Approval already ${existing.status}`);
  }

  return ok({ id: row.id, status: "rejected" });
}
