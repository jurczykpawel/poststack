import type { JobHelpers } from "graphile-worker";
import type { IncomingReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, messageReactions } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEvent, isEventTerminal, markEventStatus, markEventOnTerminalFailure } from "@/lib/idempotency";
import { dispatchAlert } from "@/lib/notifications/alert";
import { resolveContactConversation } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Process an emoji reaction to one of our messages.
 *
 * 1. Resolve the channel from pageId
 * 2. Upsert the reactor's contact + conversation
 * 3. Evaluate `reaction` rules (no inbound message row is stored — a reaction
 *    is not a message). The reply goes out as a DM via the reactor's PSID.
 */
export async function processIncomingReaction(
  payload: IncomingReactionJob,
  helpers: JobHelpers,
): Promise<void> {
  const { platform, pageId, senderId, reactionType } = payload;

  if (!senderId) {
    helpers.logger.info("Reaction without sender id, skipping");
    return;
  }

  // Scope by platform so a numeric id shared across platforms cannot route into
  // the wrong channel/workspace.
  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.platform_id, pageId),
      eq(channels.platform, platform as typeof channels.platform.enumValues[number]),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, workspace_id: true, platform: true, status: true, platform_id: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${sanitizeForLog(pageId)}, skipping reaction`);
    return;
  }

  // Drop a reaction authored by the page itself — the reaction-path analog of the DM path's
  // is_echo skip (webhooks/meta/route.ts) and the comment path's from-is-page guard.
  // Without it a page-sender reaction would materialize the page as a self-contact (this runs
  // before rule eval, so unconditionally — even with no reaction rule) and any reaction rule would
  // fire a doomed self-DM. Bounded (a DM generates no further reaction → no loop), but a correct
  // defense-in-depth guard regardless: reactions were the last self-trigger event type without one.
  // platform_id is NOT NULL, so this only ever matches a real page id.
  if (senderId === channel.platform_id) {
    helpers.logger.info(`Reaction from own page (pageId=${sanitizeForLog(pageId)}), skipping — self-guard`);
    // The edge already logged this event; record that we intentionally did not act on it.
    if (payload.eventKey) await markEventStatus(payload.eventKey, "ignored");
    return;
  }

  // A reaction is not stored as a message, so unlike DMs/comments it has no natural
  // ingest-dedup row — its identity lives in the durable event-dedup store. Check it BEFORE
  // resolving (and mutating) the contact/conversation, so a redelivery of an already-handled
  // reaction can't reopen/reorder the conversation. A still-unprocessed event (first
  // delivery, or a retry whose prior attempt rolled back) falls through and is claimed
  // atomically inside evaluateRules.
  // Prefer the event_key the edge logged under; fall back to a stable per-event key for a direct
  // worker invocation that skipped the edge log.
  const eventKey = payload.eventKey ?? `reaction:${channel.id}:${senderId}:${payload.reactedMid}:${reactionType ?? ""}:${payload.timestamp ?? ""}`;
  if (await isEventTerminal(eventKey)) {
    helpers.logger.info("Reaction already processed, skipping redelivery");
    return;
  }

  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel,
    senderId,
    null,
    reactionType ? `Reacted: ${reactionType}` : "Reacted",
    // A reaction is low-signal: it must not resurface a conversation the operator closed.
    { reopenClosed: false },
  );

  // Record the reaction so it shows in the conversation thread (PRO contacts-CRM view),
  // independent of whether any rule fires. Idempotent on (channel, contact, reacted message)
  // so a redelivery or a changed reaction updates in place rather than duplicating.
  if (payload.reactedMid) {
    await db
      .insert(messageReactions)
      .values({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        conversation_id: conversationId,
        contact_id: contactId,
        reacted_mid: payload.reactedMid,
        reaction_type: reactionType ?? "unknown",
        emoji: payload.emoji ?? null,
      })
      .onConflictDoUpdate({
        target: [messageReactions.channel_id, messageReactions.contact_id, messageReactions.reacted_mid],
        set: { reaction_type: reactionType ?? "unknown", emoji: payload.emoji ?? null, created_at: new Date() },
      });
  }

  if (isAutomationPaused || channel.status === "paused") {
    // Paused conversation OR manually paused channel: no automation, but still terminally
    // claim so a redelivery after unpause doesn't fire on an old reaction.
    await claimEvent(eventKey, "paused", { contact_id: contactId, conversation_id: conversationId }, db, { event_type: "reaction" });
    helpers.logger.info(`Automation paused for conversation=${conversationId}, not replying to reaction`);
    return;
  }

  let ruleId: string | null;
  try {
    ({ ruleId } = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      conversationId,
      contactId,
      recipientPlatformId: senderId,
      text: null,
      eventType: "message",
      isReaction: true,
      reactionType: reactionType ?? undefined,
      eventKey,
    }));
  } catch (err) {
    // On the final attempt the reply is permanently lost — record the event as `error` (with the
    // reason) before rethrowing, so the failure is visible in the log rather than silent.
    const final = await markEventOnTerminalFailure(helpers, eventKey, err, { contact_id: contactId, conversation_id: conversationId });
    if (final) await dispatchAlert({ type: "event_error", channelId: channel.id, workspaceId: channel.workspace_id, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  if (ruleId) {
    helpers.logger.info(`Reaction rule fired: ${ruleId}`);
  }
}
