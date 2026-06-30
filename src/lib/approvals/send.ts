import { sql, type SQL } from "drizzle-orm";
import { addJobTx } from "@/lib/queue/client";
import { TASK_MAX_ATTEMPTS } from "@/lib/queue/spec";
import type { MessageContent } from "@/lib/platforms/base";
import type {
  OutgoingCommentJob,
  OutgoingMessageJob,
  OutgoingPrivateReplyJob,
} from "@/lib/queue/types";

/** Anything that can run `.execute` — a Drizzle db or an open transaction (mirrors addJobTx). */
type TxExecutor = { execute: (query: SQL) => Promise<unknown> };

/**
 * The two keys that make a re-enqueue safe:
 *  - `jobKey`         — graphile-worker dedup: a replaced/pending job with the same key collapses.
 *  - `idempotencyKey` — carried into the outbound payload; the delivery worker dedups its actual
 *                       send on it (the durable outbox ledger key).
 * The DM and comment parts MUST use distinct keys so both can ride one transaction without
 * clobbering each other.
 */
interface SendKeys {
  jobKey: string;
  idempotencyKey: string;
}

/**
 * Enqueue a public-comment reply (the comment part of a proposed reply) inside the caller's
 * transaction. Shared by the approve handler and the AI-draft autosend path so the comment
 * send/job shape lives in ONE place.
 */
export async function enqueueCommentReply(
  tx: TxExecutor,
  args: {
    channelId: string;
    contactId: string;
    comment: { text: string; commentId: string };
    sentByRuleId?: string;
    keys: SendKeys;
  },
): Promise<void> {
  const job: OutgoingCommentJob = {
    channelId: args.channelId,
    contactId: args.contactId,
    commentId: args.comment.commentId,
    text: args.comment.text,
    sentByRuleId: args.sentByRuleId,
    idempotencyKey: args.keys.idempotencyKey,
  };
  await addJobTx(tx, "outgoing-comment", job, {
    jobKey: args.keys.jobKey,
    maxAttempts: TASK_MAX_ATTEMPTS["outgoing-comment"],
  });
}

/**
 * Enqueue the DM part of a proposed reply inside the caller's transaction. When the reply was
 * triggered by a comment (`commentId` set) it goes out as a first-touch PRIVATE reply (addressed by
 * comment id — a fresh commenter has no usable PSID yet); otherwise it's a PSID-addressed
 * outgoing-message. Shared by the approve handler and the AI-draft autosend path.
 */
export async function enqueueDmReply(
  tx: TxExecutor,
  args: {
    channelId: string;
    conversationId: string;
    contactId: string;
    recipientPlatformId: string;
    content: MessageContent;
    commentId?: string;
    sentByRuleId?: string;
    keys: SendKeys;
  },
): Promise<void> {
  if (args.commentId) {
    const job: OutgoingPrivateReplyJob = {
      channelId: args.channelId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      commentId: args.commentId,
      text: args.content.text ?? "",
      content: args.content,
      sentByRuleId: args.sentByRuleId,
      idempotencyKey: args.keys.idempotencyKey,
    };
    await addJobTx(tx, "outgoing-private-reply", job, {
      jobKey: args.keys.jobKey,
      maxAttempts: TASK_MAX_ATTEMPTS["outgoing-private-reply"],
    });
    return;
  }
  const job: OutgoingMessageJob = {
    channelId: args.channelId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    recipientPlatformId: args.recipientPlatformId,
    content: args.content,
    sentByRuleId: args.sentByRuleId,
    idempotencyKey: args.keys.idempotencyKey,
  };
  await addJobTx(tx, "outgoing-message", job, {
    jobKey: args.keys.jobKey,
    maxAttempts: TASK_MAX_ATTEMPTS["outgoing-message"],
  });
}

// Re-export the (TxExecutor) sql type users may need is intentionally omitted — callers pass their tx.
export type { TxExecutor };
