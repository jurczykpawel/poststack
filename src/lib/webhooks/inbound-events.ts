import { emitEvent } from "@/lib/events";
import { hasFeature } from "@/lib/license/gate";

type Tx = Parameters<typeof emitEvent>[0];

/** Identifiers only: the receiver reads the content through GET /api/v1/messages|comments/{id}. */
type InboundRef = {
  workspaceId: string;
  channelId: string;
  platform: string;
  conversationId: string;
  contactId: string;
  createdAt: Date;
};

/** Inbound (contact-authored) item events are part of outbound webhooks, a PRO capability. Call from
 *  the same transaction as the insert; never for our own sends or echoes. */
async function emitInbound(tx: Tx, type: string, subject: "message" | "comment", id: string, ref: InboundRef, extra: Record<string, unknown>): Promise<void> {
  if (!(await hasFeature("outbound_webhooks"))) return;
  const { createdAt, ...ids } = ref;
  await emitEvent(tx, ref.workspaceId, type, { type: subject, id }, {
    ...ids, [`${subject}Id`]: id, ...extra, direction: "inbound", createdAt: createdAt.toISOString(),
  });
}

export const emitMessageReceived = (tx: Tx, messageId: string, ref: InboundRef) =>
  emitInbound(tx, "message.received", "message", messageId, ref, {});

export const emitCommentReceived = (tx: Tx, commentId: string, ref: InboundRef, postId: string | null) =>
  emitInbound(tx, "comment.received", "comment", commentId, ref, { postId });
