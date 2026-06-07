import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { pendingApprovals } from "@/db/schema";
import { ok, ApiErrors } from "@/lib/api/response";
import { addJob } from "@/lib/queue/client";
import type { MessageContent } from "@/lib/platforms/base";

export const runtime = "nodejs";

// POST /api/v1/approvals/:approvalId/approve — send the parked reply
export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { approvalId } = await params;
  const resolvedBy = auth.userId.startsWith("api-key:") ? null : auth.userId;

  // Atomic flip: only a still-pending row in this workspace transitions, so a
  // double-approve cannot enqueue the send twice.
  const [row] = await db
    .update(pendingApprovals)
    .set({ status: "approved", resolved_at: new Date(), resolved_by: resolvedBy })
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

  const content = (row.proposed_content as { content?: MessageContent | null }).content ?? null;
  const hasSomething = !!content && (!!content.text || !!content.buttons?.length || !!content.quick_replies?.length);
  if (hasSomething) {
    await addJob("outgoing-message", {
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      recipientPlatformId: row.recipient_platform_id,
      content: content!,
      sentByRuleId: row.rule_id,
      idempotencyKey: randomUUID(),
    });
  }

  return ok({ id: row.id, status: "approved", queued: hasSomething });
}
