import type { JobHelpers } from "graphile-worker";
import type { IncomingReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEventOnce, isEventProcessed } from "@/lib/idempotency";
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
    columns: { id: true, workspace_id: true, platform: true, status: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${sanitizeForLog(pageId)}, skipping reaction`);
    return;
  }

  // A reaction is not stored as a message, so unlike DMs/comments it has no natural
  // ingest-dedup row — its identity lives in the durable event-dedup store. Check it BEFORE
  // resolving (and mutating) the contact/conversation, so a redelivery of an already-handled
  // reaction can't reopen/reorder the conversation. A still-unprocessed event (first
  // delivery, or a retry whose prior attempt rolled back) falls through and is claimed
  // atomically inside evaluateRules.
  const eventKey = `reaction:${channel.id}:${senderId}:${payload.reactedMid}:${reactionType ?? ""}:${payload.timestamp ?? ""}`;
  if (await isEventProcessed(eventKey)) {
    helpers.logger.info("Reaction already processed, skipping redelivery");
    return;
  }

  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel,
    senderId,
    null,
    reactionType ? `Reacted: ${reactionType}` : "Reacted",
  );

  if (isAutomationPaused || channel.status === "paused") {
    // Paused conversation OR manually paused channel: no automation, but still terminally
    // claim so a redelivery after unpause doesn't fire on an old reaction.
    await claimEventOnce(eventKey);
    helpers.logger.info(`Automation paused for conversation=${conversationId}, not replying to reaction`);
    return;
  }

  const { ruleId } = await evaluateRules({
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
  });
  if (ruleId) {
    helpers.logger.info(`Reaction rule fired: ${ruleId}`);
  }
}
