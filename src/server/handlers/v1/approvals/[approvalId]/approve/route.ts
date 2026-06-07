import { and, eq, sql } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { pendingApprovals } from "@/db/schema";
import { TASK_MAX_ATTEMPTS } from "@/lib/queue/spec";
import { ok, ApiErrors } from "@/lib/api/response";
import type { MessageContent } from "@/lib/platforms/base";
import type { OutgoingMessageJob } from "@/lib/queue/types";

export const runtime = "nodejs";

type Outcome =
  | { kind: "ok"; queued: boolean }
  | { kind: "notfound" }
  | { kind: "conflict"; status: string };

// POST /api/v1/approvals/:approvalId/approve — send the parked reply.
//
// The status flip and the outbound enqueue run in ONE transaction (via
// graphile_worker.add_job): if the enqueue fails the flip rolls back, so an
// approved-but-never-sent reply cannot occur. The where-pending guard makes a
// double-approve a no-op (409), and a deterministic idempotency key means even
// a retried enqueue results in a single send.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ approvalId: string }> },
) {
  const auth = await authenticateWithScope(request, "conversations:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const { approvalId } = await params;
  const resolvedBy = auth.userId.startsWith("api-key:") ? null : auth.userId;

  const outcome: Outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [row] = await tx
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
      const existing = await tx.query.pendingApprovals.findFirst({
        where: and(eq(pendingApprovals.id, approvalId), eq(pendingApprovals.workspace_id, auth.workspaceId)),
        columns: { status: true },
      });
      return existing ? { kind: "conflict", status: existing.status } : { kind: "notfound" };
    }

    const content = (row.proposed_content as { content?: MessageContent | null }).content ?? null;
    const hasSomething = !!content && (!!content.text || !!content.buttons?.length || !!content.quick_replies?.length);

    if (hasSomething) {
      const job: OutgoingMessageJob = {
        channelId: row.channel_id,
        conversationId: row.conversation_id,
        contactId: row.contact_id,
        recipientPlatformId: row.recipient_platform_id,
        content: content!,
        sentByRuleId: row.rule_id,
        idempotencyKey: `approval:${row.id}`,
      };
      // Same transaction as the status flip → atomic outbox: if this fails, the
      // flip rolls back and the approval stays pending (retryable).
      await tx.execute(sql`
        select graphile_worker.add_job(
          'outgoing-message',
          ${JSON.stringify(job)}::json,
          max_attempts => ${TASK_MAX_ATTEMPTS["outgoing-message"]},
          job_key => ${`approval-${row.id}`}
        )
      `);
    }

    return { kind: "ok", queued: hasSomething };
  });

  if (outcome.kind === "notfound") return ApiErrors.notFound("Approval");
  if (outcome.kind === "conflict") return ApiErrors.conflict(`Approval already ${outcome.status}`);
  return ok({ id: approvalId, status: "approved", queued: outcome.queued });
}
