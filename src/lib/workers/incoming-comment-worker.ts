import type { JobHelpers } from "graphile-worker";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, commentLogs, conversations } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEventOnce } from "@/lib/idempotency";
import { resolveContactConversation } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Process an incoming comment on a Facebook post or Instagram media.
 *
 * 1. Resolve Channel from pageId
 * 2. Log the comment (dedup by unique constraint on channel_id + platform_comment_id)
 * 3. Upsert a contact + conversation for the commenter, then evaluate rules.
 *    Works first-touch: a commenter who never DM'd still gets a public reply
 *    and/or a private reply (addressed by comment_id).
 */
export async function processIncomingComment(
  payload: IncomingCommentJob,
  helpers: JobHelpers,
): Promise<void> {
  const { platform, pageId, commentId, postId, senderId, senderName, text } = payload;

  if (!text) {
    helpers.logger.info(`Empty comment commentId=${sanitizeForLog(commentId)}, skipping`);
    return;
  }

  // 1. Find active channel — scoped by platform so a numeric id shared across
  //    platforms cannot route into the wrong channel/workspace.
  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.platform_id, pageId),
      eq(channels.platform, platform as typeof channels.platform.enumValues[number]),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, workspace_id: true, platform: true, status: true, platform_id: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${sanitizeForLog(pageId)}, skipping`);
    return;
  }

  // Drop the page's OWN comment — the comment-path analog of the DM path's `is_echo` skip
  // (webhooks/meta/route.ts). When a rule posts a public reply, Meta redelivers that reply as a
  // fresh `feed`/`comments` change with a NEW comment_id and `from.id === page id`. Without this
  // guard it logs as a new comment, re-matches the rule (a post_id-only rule matches EVERY comment
  // on the post), and posts yet another reply — an unbounded comment-bot self-loop that cooldown/cap
  // only slow, never stop. `platform_id` is NOT NULL, so this only ever matches a real page id
  //.
  if (senderId === channel.platform_id) {
    helpers.logger.info(`Comment from own page (commentId=${sanitizeForLog(commentId)}), skipping — self-loop guard`);
    return;
  }

  // 2. Log the comment for the inbox — unique constraint dedups a redelivery
  //    idempotently. Logging is just storage; it does NOT gate the rule evaluation
  //    below, so a retry after a failed reply still re-evaluates.
  const [logged] = await db
    .insert(commentLogs)
    .values({
      channel_id: channel.id,
      workspace_id: channel.workspace_id,
      post_id: postId ?? null,
      platform_comment_id: commentId,
      author_id: senderId ?? null,
      author_name: senderName ?? null,
      comment_text: text,
    })
    .onConflictDoNothing({ target: [commentLogs.channel_id, commentLogs.platform_comment_id] })
    .returning({ id: commentLogs.id });

  helpers.logger.info(
    // Log the internal comment-log row id, NOT the commenter's platform author-id: the author-id is
    // contact PII (PSID-class) that the rest of the system treats as erasable (GDPR contact.erased
    // even prunes PSID-bearing dedup keys), but application logs sit outside that erasure boundary —
    // so logging it would leave an erased contact's id in rotated log files.
    logged
      ? `Logged comment=${sanitizeForLog(commentId)} post=${sanitizeForLog(postId ?? "")} log=${logged.id}`
      : `commentId=${sanitizeForLog(commentId)} already logged — re-evaluating (idempotent via event key)`,
  );

  // 3. Upsert the commenter as a contact + conversation, then evaluate rules.
  //    The commenter is keyed by their comment author id. A DM reply is sent via
  //    private_replies (comment_id), so no prior messaging PSID is required.
  if (!senderId) return;

  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel,
    senderId,
    senderName ?? null,
    truncateCodePoints(text, 255),
    // Only a newly-logged comment bumps activity; a redelivery/retry of an old comment
    // resolves identity without reordering the inbox or reopening the conversation.
    { mutateActivity: !!logged },
  );

  // A newly-logged comment is unread work for the operator (a fresh comment on a brand-new
  // conversation would otherwise show 0 unread). Bump the badge, mirroring the DM worker; a
  // redelivery (already logged) does not re-count.
  if (logged) {
    await db.update(conversations)
      .set({ unread_count: sql`${conversations.unread_count} + 1` })
      .where(eq(conversations.id, conversationId));
  }

  const eventKey = `comment:${channel.id}:${commentId}`;

  if (isAutomationPaused || channel.status === "paused") {
    // A paused conversation OR a manually paused channel runs no automation, but the event
    // is still terminally claimed so a redelivery after unpause doesn't reply late.
    await claimEventOnce(eventKey);
    helpers.logger.info(`Automation paused for conversation=${conversationId}, not replying`);
    return;
  }

  // Always evaluate (even on a redelivery): the event key makes the rule fire at most once
  // — claimed in the same transaction as the reply enqueue — and any failure propagates so
  // the job retries instead of being swallowed and lost to the comment-log dedup.
  const { outcome, ruleId } = await evaluateRules({
    workspaceId: channel.workspace_id,
    channelId: channel.id,
    conversationId,
    contactId,
    recipientPlatformId: senderId,
    text,
    eventType: "comment",
    postId: postId ?? undefined,
    commentId,
    eventKey,
  });
  // An unmatched comment is unhandled work for the operator — raise the attention badge, mirroring
  // the DM worker. Only for an outcome THIS call decided (`no_match`): a redelivery returns
  // `already` and leaves the flag untouched, so it can't re-raise a flag a human just cleared. A
  // reaction is deliberately NOT flagged — it's a low-signal acknowledgement, not awaiting a reply
  // (same rationale as 's reopen-suppression).
  if (outcome === "no_match") {
    await db.update(conversations)
      .set({ needs_manual_reply: true })
      .where(eq(conversations.id, conversationId));
  }
  if (ruleId) {
    helpers.logger.info(`Comment rule fired: ${ruleId}`);
  }
}
