import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { messages, outboundDeliveries, pendingApprovals } from "@/db/schema";
import { isUuid } from "@/lib/api/identifiers";
import { isContactSubscribed } from "@/lib/contacts/consent";
import { db } from "@/lib/db";
import { normalizeOutgoingAttachments } from "@/lib/messages/attachments";
import type { MessageContent } from "@/lib/platforms/base";
import { addJobTx } from "@/lib/queue/client";
import type { TaskPayloadMap } from "@/lib/queue/types";
import { redactSecrets } from "@/lib/redact";
import { truncateCodePoints } from "@/lib/text";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const APPROVAL_DELIVERY_PREFIX = "approval:";
export const approvalDeliveryKey = (id: string, comment = false) => `${APPROVAL_DELIVERY_PREFIX}${id}${comment ? ":comment" : ""}`;
export const retryableApprovalDelivery = (status: SQLWrapper, payload: SQLWrapper) =>
  sql<boolean>`(${status} in ('failed', 'expired') and ${payload}->>'failedMessageId' is not null)`;

export function approvalIdFromDelivery(key: string): string | undefined {
  const [prefix, id, surface] = key.split(":");
  if (prefix === "approval" && isUuid(id) && key === approvalDeliveryKey(id, surface === "comment")) return id;
}

export async function recordApprovalFailure(tx: Tx, args: {
  approvalId: string; workspaceId: string; channelId: string; payload: Record<string, unknown>;
  reason: string; dmConversationId?: string;
}) {
  const approval = await tx.query.pendingApprovals.findFirst({
    where: and(eq(pendingApprovals.id, args.approvalId), eq(pendingApprovals.workspace_id, args.workspaceId),
      eq(pendingApprovals.channel_id, args.channelId), eq(pendingApprovals.status, "approved")),
    columns: { conversation_id: true, rule_id: true },
  });
  if (!approval) return args.payload;
  const conversationId = args.dmConversationId ?? approval.conversation_id;
  const failure = { status: "failed" as const, failure_reason: truncateCodePoints(redactSecrets(args.reason), 500) };
  const heldId = args.payload.heldMessageId;
  const [updated] = typeof heldId === "string" ? await tx.update(messages).set(failure)
    .where(and(eq(messages.id, heldId), eq(messages.conversation_id, conversationId))).returning({ id: messages.id }) : [];
  const content = (args.payload.content ?? { text: args.payload.text }) as MessageContent;
  const [message] = updated ? [updated] : await tx.insert(messages).values({
    ...failure, conversation_id: conversationId, direction: "outbound", text: content.text ?? null,
    attachments: normalizeOutgoingAttachments(content), sent_by_rule_id: approval.rule_id,
  }).returning({ id: messages.id });
  return { ...args.payload, failedMessageId: message.id };
}

export async function retryApprovedReply(workspaceId: string, approvalId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const approval = await tx.query.pendingApprovals.findFirst({
      where: and(eq(pendingApprovals.id, approvalId), eq(pendingApprovals.workspace_id, workspaceId), eq(pendingApprovals.status, "approved")),
      columns: { contact_id: true, channel_id: true, conversation_id: true },
    });
    if (!approval || !await isContactSubscribed(tx, approval.contact_id)) return false;
    const rows = await tx.update(outboundDeliveries).set({ status: "pending", attempts: 0, last_error: null })
      .where(and(eq(outboundDeliveries.workspace_id, workspaceId), eq(outboundDeliveries.channel_id, approval.channel_id),
        inArray(outboundDeliveries.delivery_key, [approvalDeliveryKey(approvalId), approvalDeliveryKey(approvalId, true)]),
        retryableApprovalDelivery(outboundDeliveries.status, outboundDeliveries.payload)))
      .returning();
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      const task = row.task_name as "outgoing-message" | "outgoing-private-reply" | "outgoing-comment";
      const retry = { ...payload, conversationId: approval.conversation_id, heldMessageId: payload.failedMessageId };
      await addJobTx(tx, task, retry as unknown as TaskPayloadMap[typeof task],
        { jobKey: `retry:${row.delivery_key}` });
    }
    return rows.length > 0;
  });
}
