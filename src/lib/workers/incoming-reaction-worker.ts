import type { JobHelpers } from "graphile-worker";
import type { IncomingReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { resolveContactConversation } from "./resolve-contact";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { claimOnce, release } from "@/lib/idempotency";

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

  if (isAutomationPaused) {
    helpers.logger.info(`Automation paused for conversation=${conversationId}, not replying to reaction`);
    return;
  }

  // A reaction is not stored as a message, so unlike DMs/comments it has no natural
  // ingest-dedup row. Claim its identity once — right before firing — so a redelivered
  // webhook batch (we 503 on partial enqueue failure) cannot fire the rule, and send
  // the reply, twice. claimOnce is atomic, so even concurrent redeliveries can't both win.
  const dedupKey = `reaction:${channel.id}:${senderId}:${payload.reactedMid}:${reactionType ?? ""}:${payload.timestamp ?? ""}`;
  if (!(await claimOnce(dedupKey))) {
    helpers.logger.info("Reaction already processed, skipping redelivery");
    return;
  }

  try {
    const matchedRuleId = await evaluateRules({
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      conversationId,
      contactId,
      recipientPlatformId: senderId,
      text: null,
      eventType: "message",
      isReaction: true,
      reactionType: reactionType ?? undefined,
    });
    if (matchedRuleId) {
      helpers.logger.info(`Reaction rule fired: ${matchedRuleId}`);
    }
  } catch (err) {
    // The claim stands for committed effects. If processing failed, release it and let
    // the error propagate so the job is retried (and re-claimed) — otherwise the claim
    // would permanently suppress this reaction's reply on every redelivery.
    await release(dedupKey);
    throw err;
  }
}
