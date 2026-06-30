import { and, eq } from "drizzle-orm";
import { authenticateWithScope } from "@/lib/auth";
import { db } from "@/lib/db";
import { pendingApprovals, autoReplyRules } from "@/db/schema";
import { acquireCooldown, incrementSendCount } from "@/lib/rules/limits";
import { ok, ApiErrors } from "@/lib/api/response";
import { enqueueCommentReply, enqueueDmReply } from "@/lib/approvals/send";
import { isContactSubscribed } from "@/lib/contacts/consent";
import type { ProposedContent } from "@/lib/approvals/draft";

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

    const proposed = row.proposed_content as ProposedContent;
    const content = proposed.content ?? null;
    const comment = proposed.comment ?? null;
    const hasDm = !!content && (!!content.text || !!content.buttons?.length || !!content.quick_replies?.length);
    const hasComment = !!comment?.text && !!comment?.commentId;
    const hasSomething = hasDm || hasComment;

    // Consent gate at the actual send: the contact may have unsubscribed AFTER the reply
    // was parked — and an approval can sit pending for an unbounded time, a wider window than a
    // normal auto-reply. Re-check like the sequence + follow-gate workers: the
    // human's approve is still recorded, but nothing goes out to an unsubscribed contact and the
    // rule's limits are not charged for a send that never happens.
    const consented = await isContactSubscribed(tx, row.contact_id);

    if (hasSomething && consented) {
      // Charge the rule's limits NOW — at the actual send — not when the proposal was
      // parked, so a rejected/abandoned approval costs nothing. The cooldown starts
      // and the lifetime send-count counts this one delivery; a human approve is a deliberate
      // send, so an at-cap counter is left as-is rather than blocking.
      const rule = row.rule_id
        ? await tx.query.autoReplyRules.findFirst({
            where: eq(autoReplyRules.id, row.rule_id),
            columns: { cooldown_seconds: true, max_sends_per_contact: true },
          })
        : null;
      if (rule) {
        await acquireCooldown(row.rule_id!, row.contact_id, rule.cooldown_seconds, tx);
        if (rule.max_sends_per_contact != null) {
          await incrementSendCount(row.rule_id!, row.contact_id, rule.max_sends_per_contact, tx);
        }
      }

      // Public comment reply (reply_mode comment/both). Distinct job_key + idempotency key from the
      // DM so both can be enqueued in this one transaction without clobbering each other. The
      // send/job shape is shared with the AI-draft autosend path (lib/approvals/send.ts).
      if (hasComment) {
        await enqueueCommentReply(tx, {
          channelId: row.channel_id,
          contactId: row.contact_id,
          comment: { text: comment!.text!, commentId: comment!.commentId! },
          sentByRuleId: row.rule_id ?? undefined,
          keys: { jobKey: `approval-${row.id}-comment`, idempotencyKey: `approval:${row.id}:comment` },
        });
      }

      if (hasDm) {
        // A comment-triggered DM goes out as a private reply (by comment_id); a plain keyword/DM
        // approval sends by PSID. Same transaction as the status flip → atomic outbox: a failed
        // enqueue rolls the flip back and the approval stays pending (retryable). The branch lives in
        // the shared helper so the approve + AI-draft paths can't drift.
        await enqueueDmReply(tx, {
          channelId: row.channel_id,
          conversationId: row.conversation_id,
          contactId: row.contact_id,
          recipientPlatformId: row.recipient_platform_id,
          content: content!,
          commentId: comment?.commentId ?? undefined,
          sentByRuleId: row.rule_id ?? undefined,
          keys: { jobKey: `approval-${row.id}`, idempotencyKey: `approval:${row.id}` },
        });
      }
    }

    return { kind: "ok", queued: hasSomething && consented };
  });

  if (outcome.kind === "notfound") return ApiErrors.notFound("Approval");
  if (outcome.kind === "conflict") return ApiErrors.conflict(`Approval already ${outcome.status}`);
  return ok({ id: approvalId, status: "approved", queued: outcome.queued });
}
