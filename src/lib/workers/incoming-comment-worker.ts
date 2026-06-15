import type { JobHelpers } from "graphile-worker";
import type { IncomingCommentJob } from "@/lib/queue/types";
import { truncateCodePoints } from "@/lib/text";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, commentLogs, contacts, conversations, type Platform } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEvent, markEventStatus, linkEventOutcome, markEventOnTerminalFailure } from "@/lib/idempotency";
import { dispatchAlert } from "@/lib/notifications/alert";
import { resolveContactConversation } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Best-effort public permalink of the post a comment is on, so the inbox can link to it.
 * Facebook builds its URL from post_id at render time (no provider method), so this only does work
 * for platforms whose ids don't map to a URL by construction (Instagram). Reuses a permalink already
 * stored for another comment on the same post to avoid an API call per comment. Never throws — a
 * failed/absent permalink just means no link, which must not block logging the comment.
 */
async function resolvePostUrl(
  channel: { id: string; platform: Platform; token_encrypted: string },
  postId: string,
  helpers: JobHelpers,
): Promise<string | null> {
  const provider = getProvider(channel.platform);
  if (!provider.getPostUrl) return null;
  const existing = await db.query.commentLogs.findFirst({
    where: and(
      eq(commentLogs.channel_id, channel.id),
      eq(commentLogs.post_id, postId),
      isNotNull(commentLogs.post_url),
    ),
    columns: { post_url: true },
  });
  if (existing?.post_url) return existing.post_url;
  try {
    return await provider.getPostUrl(decryptTokens(channel.token_encrypted), postId);
  } catch (err) {
    helpers.logger.info(`post-url resolve failed post=${sanitizeForLog(postId)}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

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
    columns: { id: true, workspace_id: true, platform: true, status: true, platform_id: true, token_encrypted: true },
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
    // The edge already logged this event; record that we intentionally did not act on it.
    if (payload.eventKey) await markEventStatus(payload.eventKey, "ignored");
    return;
  }

  // 2. The comment-log row values, shared by the no-sender quick-log path and the atomic path below.
  const postUrl = postId ? await resolvePostUrl(channel, postId, helpers) : null;
  const logValues = {
    channel_id: channel.id,
    workspace_id: channel.workspace_id,
    post_id: postId ?? null,
    post_url: postUrl,
    platform_comment_id: commentId,
    author_id: senderId ?? null,
    author_name: senderName ?? null,
    comment_text: text,
  };
  // Log the internal comment-log row id, NOT the commenter's platform author-id: the author-id is
  // contact PII (PSID-class) that the rest of the system treats as erasable (GDPR contact.erased even
  // prunes PSID-bearing dedup keys), but application logs sit outside that erasure boundary — so
  // logging it would leave an erased contact's id in rotated log files.
  const logLine = (id: string | null) =>
    id
      ? `Logged comment=${sanitizeForLog(commentId)} post=${sanitizeForLog(postId ?? "")} log=${id}`
      : `commentId=${sanitizeForLog(commentId)} already logged — re-evaluating (idempotent via event key)`;

  // A comment with no commenter id can't resolve a contact/conversation. Still log it for the inbox
  // (unique constraint dedups a redelivery) and stop — there's nothing to count unread against.
  if (!senderId) {
    const [logged] = await db
      .insert(commentLogs).values(logValues)
      .onConflictDoNothing({ target: [commentLogs.channel_id, commentLogs.platform_comment_id] })
      .returning({ id: commentLogs.id });
    helpers.logger.info(logLine(logged?.id ?? null));
    return;
  }

  // 3. Resolve the commenter's identity WITHOUT mutating activity — the fresh-comment activity bump
  //    (reorder/reopen) is applied atomically with the log insert below, so a redelivery
  //    that finds the comment already logged neither reorders the inbox nor reopens it.
  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel,
    senderId,
    senderName ?? null,
    truncateCodePoints(text, 255),
    // A comment belongs to a per-post thread (one thread per post the commenter touched), distinct
    // from their DM thread. postId is the thread anchor; '' when the platform omitted it.
    { mutateActivity: false, thread: { type: "comment", ref: postId ?? "" } },
  );

  // 4. Log the comment AND its activity/unread counters in ONE transaction: a crash between
  //    the log insert and the counter updates would otherwise leave the comment logged but the
  //    counters permanently skipped (the retry sees the insert conflict, treats it as a duplicate —
  //    `logged=null` — and never re-applies them). A newly-logged comment is unread work + newest
  //    activity; a redelivery (insert conflict → no row) skips both. The bump here
  //    replicates what resolveContactConversation(mutateActivity:true) used to do for a fresh comment.
  const loggedId = await db.transaction(async (tx) => {
    const [logged] = await tx
      .insert(commentLogs).values({ ...logValues, conversation_id: conversationId })
      .onConflictDoNothing({ target: [commentLogs.channel_id, commentLogs.platform_comment_id] })
      .returning({ id: commentLogs.id });
    if (!logged) return null;
    await tx.update(conversations)
      .set({ last_message_at: new Date(), status: "open" })
      .where(eq(conversations.id, conversationId));
    await tx.update(contacts)
      .set({ last_interaction_at: new Date() })
      .where(eq(contacts.id, contactId));
    await tx.update(conversations)
      .set({ unread_count: sql`${conversations.unread_count} + 1` })
      .where(eq(conversations.id, conversationId));
    return logged.id;
  });
  helpers.logger.info(logLine(loggedId));

  // Prefer the event_key the edge logged under; fall back per-(channel, comment) for a direct
  // worker invocation that skipped the edge log.
  const eventKey = payload.eventKey ?? `comment:${channel.id}:${commentId}`;

  if (isAutomationPaused || channel.status === "paused") {
    // A paused conversation OR a manually paused channel runs no automation, but the event
    // is still terminally claimed so a redelivery after unpause doesn't reply late.
    await claimEvent(eventKey, "paused", { contact_id: contactId, conversation_id: conversationId, comment_log_id: loggedId }, db, { event_type: "comment" });
    helpers.logger.info(`Automation paused for conversation=${conversationId}, not replying`);
    return;
  }

  // Always evaluate (even on a redelivery): the event key makes the rule fire at most once
  // — claimed in the same transaction as the reply enqueue — and any failure propagates so
  // the job retries instead of being swallowed and lost to the comment-log dedup.
  let outcome: "fired" | "no_match" | "already";
  let ruleId: string | null;
  try {
    ({ outcome, ruleId } = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      platform: channel.platform,
      conversationId,
      contactId,
      recipientPlatformId: senderId,
      text,
      eventType: "comment",
      postId: postId ?? undefined,
      commentId,
      eventKey,
    }));
  } catch (err) {
    // On the final attempt the reply is permanently lost — record the event as `error` (with the
    // reason) before rethrowing, so the failure is visible in the log rather than silent.
    const final = await markEventOnTerminalFailure(helpers, eventKey, err, { contact_id: contactId, conversation_id: conversationId, comment_log_id: loggedId });
    if (final) await dispatchAlert({ type: "event_error", channelId: channel.id, workspaceId: channel.workspace_id, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  // Attach the comment-log row to the now-claimed event (the executor records contact/conversation
  // inside the fire tx; the comment-log id is only known here). Skip on `already` (a redelivery
  // must not clobber the original).
  if (outcome !== "already") await linkEventOutcome(eventKey, { comment_log_id: loggedId });
  // An unmatched comment is unhandled work for the operator — raise the attention badge, mirroring
  // the DM worker. Only for an outcome THIS call decided (`no_match`): a redelivery returns
  // `already` and leaves the flag untouched, so it can't re-raise a flag a human just cleared. A
  // reaction is deliberately NOT flagged — it's a low-signal acknowledgement, not awaiting a reply
  // (same rationale as the reopen-suppression).
  if (outcome === "no_match") {
    await db.update(conversations)
      .set({ needs_manual_reply: true })
      .where(eq(conversations.id, conversationId));
  }
  if (ruleId) {
    helpers.logger.info(`Comment rule fired: ${ruleId}`);
  }
}
