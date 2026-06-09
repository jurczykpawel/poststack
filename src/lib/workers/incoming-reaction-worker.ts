import type { JobHelpers } from "graphile-worker";
import type { IncomingReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { claimEventOnce } from "@/lib/idempotency";
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
    columns: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${sanitizeForLog(pageId)}, skipping reaction`);
    return;
  }

  const { contactId, conversationId, isAutomationPaused } = await resolveContactConversation(
    channel,
    senderId,
    null,
    reactionType ? `Reacted: ${reactionType}` : "Reacted",
  );

  // A reaction is not stored as a message, so unlike DMs/comments it has no natural
  // ingest-dedup row. Pass a stable identity as the event key: evaluateRules claims it
  // in the same transaction as the cooldown/send-count mutations and the reply enqueue,
  // so a redelivered webhook batch (we 503 on partial enqueue failure) cannot fire the
  // rule, or send the reply, twice — and a transient failure rolls the whole thing back,
  // leaving nothing claimed, so the job simply retries.
  const eventKey = `reaction:${channel.id}:${senderId}:${payload.reactedMid}:${reactionType ?? ""}:${payload.timestamp ?? ""}`;

  if (isAutomationPaused) {
    // Still terminally claim so a redelivery after unpause doesn't fire on an old reaction.
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
