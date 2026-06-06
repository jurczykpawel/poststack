import type { JobHelpers } from "graphile-worker";
import type { IncomingReactionJob } from "@/lib/queue/types";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { evaluateRules } from "@/lib/rules/executor";
import { resolveContactConversation } from "./resolve-contact";

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
  const { pageId, senderId, reactionType } = payload;

  if (!senderId) {
    helpers.logger.info("Reaction without sender id, skipping");
    return;
  }

  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.platform_id, pageId), ne(channels.status, "disabled")),
    columns: { id: true, workspace_id: true, platform: true },
  });

  if (!channel) {
    helpers.logger.info(`No active channel for pageId=${pageId}, skipping reaction`);
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
    helpers.logger.info(`Rule evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
