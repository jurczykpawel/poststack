import { and, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { contacts, conversations, messages, outboundDeliveries, pendingApprovals } from "@/db/schema";
import { isUuid } from "@/lib/api/identifiers";
import { db } from "@/lib/db";
import { normalizeOutgoingAttachments } from "@/lib/messages/attachments";
import type { MessageContent } from "@/lib/platforms/base";
import { messagingWindowState } from "@/lib/platforms/messaging-window";
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

export function approvalRetryBlocked(subscribed: boolean | null, thread: Parameters<typeof messagingWindowState>[0]): string | null {
  if (!subscribed) return "Contact is unsubscribed.";
  // Approved replies use the standard window. A private reply originates in a comment thread.
  if (!messagingWindowState(thread).canSend) return "24h reply window closed. You can retry once the contact writes again.";
  return null;
}

function approvalThreads(tx: Tx, approval: Pick<typeof pendingApprovals.$inferSelect, "workspace_id" | "channel_id" | "contact_id" | "conversation_id">) {
  return tx.select({ id: conversations.id }).from(conversations).where(and(
    eq(conversations.workspace_id, approval.workspace_id), eq(conversations.channel_id, approval.channel_id),
    eq(conversations.contact_id, approval.contact_id),
    or(eq(conversations.id, approval.conversation_id), eq(conversations.thread_type, "dm")),
  ));
}

export async function recordApprovalFailure(tx: Tx, args: {
  approvalId: string; workspaceId: string; channelId: string; payload: Record<string, unknown>;
  reason: string; dmConversationId?: string;
}) {
  const approval = await tx.query.pendingApprovals.findFirst({
    where: and(eq(pendingApprovals.id, args.approvalId), eq(pendingApprovals.workspace_id, args.workspaceId),
      eq(pendingApprovals.channel_id, args.channelId), eq(pendingApprovals.status, "approved")),
    columns: { conversation_id: true, contact_id: true, rule_id: true, workspace_id: true, channel_id: true },
  });
  if (!approval) return args.payload;
  const conversationId = args.dmConversationId ?? approval.conversation_id;
  const failure = { status: "failed" as const, failure_reason: truncateCodePoints(redactSecrets(args.reason), 500) };
  const heldId = args.payload.heldMessageId;
  const [updated] = typeof heldId === "string" ? await tx.update(messages).set(failure)
    .where(and(eq(messages.id, heldId), inArray(messages.conversation_id, approvalThreads(tx, approval))))
    .returning({ id: messages.id }) : [];
  const content = (args.payload.content ?? { text: args.payload.text }) as MessageContent;
  const [message] = updated ? [updated] : await tx.insert(messages).values({
    ...failure, conversation_id: conversationId, direction: "outbound", text: content.text ?? null,
    attachments: normalizeOutgoingAttachments(content), sent_by_rule_id: approval.rule_id,
  }).returning({ id: messages.id });
  return { ...args.payload, failedMessageId: message.id };
}

export async function recordPendingApprovalFailure(approvalId: string, deliveryKey: string, channelId: string, error: unknown) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(outboundDeliveries).where(and(eq(outboundDeliveries.delivery_key, deliveryKey),
      eq(outboundDeliveries.channel_id, channelId), eq(outboundDeliveries.status, "pending"))).for("update");
    if (!row) return;
    const reason = truncateCodePoints(redactSecrets(error instanceof Error ? error.message : String(error)), 500);
    const stored = row.payload as Record<string, unknown>;
    const payload = await recordApprovalFailure(tx, { approvalId, channelId, workspaceId: row.workspace_id,
      payload: { ...stored, heldMessageId: stored.heldMessageId ?? stored.failedMessageId }, reason });
    await tx.update(outboundDeliveries).set({ status: "failed", last_error: reason, payload })
      .where(and(eq(outboundDeliveries.id, row.id), eq(outboundDeliveries.workspace_id, row.workspace_id)));
  });
}

export async function retryApprovedReply(workspaceId: string, approvalId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const unavailable = "This reply cannot be retried.";
    const approval = await tx.query.pendingApprovals.findFirst({
      where: and(eq(pendingApprovals.id, approvalId), eq(pendingApprovals.workspace_id, workspaceId), eq(pendingApprovals.status, "approved")),
      columns: { contact_id: true, channel_id: true, conversation_id: true, workspace_id: true },
      with: {
        contact: { columns: { is_subscribed: true }, where: eq(contacts.workspace_id, workspaceId) },
        conversation: { columns: { platform: true, thread_type: true, last_inbound_at: true }, where: eq(conversations.workspace_id, workspaceId) },
      },
    });
    if (!approval?.conversation) return unavailable;
    const thread = approval.conversation;
    const blocked = approvalRetryBlocked(approval.contact?.is_subscribed ?? null, {
      platform: thread.platform, threadType: thread.thread_type, lastInboundAt: thread.last_inbound_at,
    });
    if (blocked) return blocked;
    const rows = await tx.update(outboundDeliveries).set({ status: "pending", attempts: 0, last_error: null })
      .where(and(eq(outboundDeliveries.workspace_id, workspaceId), eq(outboundDeliveries.channel_id, approval.channel_id),
        inArray(outboundDeliveries.delivery_key, [approvalDeliveryKey(approvalId), approvalDeliveryKey(approvalId, true)]),
        retryableApprovalDelivery(outboundDeliveries.status, outboundDeliveries.payload)))
      .returning();
    for (const row of rows) {
      const payload = row.payload as Record<string, unknown>;
      const task = row.task_name as "outgoing-message" | "outgoing-private-reply" | "outgoing-comment";
      await tx.update(messages).set({ status: "pending", failure_reason: null })
        .where(and(eq(messages.id, payload.failedMessageId as string), inArray(messages.conversation_id, approvalThreads(tx, approval))));
      const retry = { ...payload, conversationId: approval.conversation_id, heldMessageId: payload.failedMessageId };
      await addJobTx(tx, task, retry as unknown as TaskPayloadMap[typeof task],
        { jobKey: `retry:${row.delivery_key}` });
    }
    return rows.length ? null : unavailable;
  });
}
