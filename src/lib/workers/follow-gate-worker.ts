import type { JobHelpers } from "graphile-worker";
import type { FollowGateJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";
import { addJob } from "@/lib/queue/client";

/**
 * Follow-gate: re-check (live) whether the recipient follows the business, then
 * enqueue the gated content — the lead magnet when they follow, a re-prompt
 * otherwise. The loop is stateless: each tap of the claim button produces one
 * follow-gate job, so the user drives the loop by following and tapping again.
 * Platforms without a follow graph (Facebook) leave the gate open and deliver.
 */
export async function processFollowGate(
  payload: FollowGateJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, contactId, recipientPlatformId, followed, notFollowed, sentByRuleId, idempotencyKey } =
    payload;

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, platform: true, token_encrypted: true, status: true },
  });

  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }
  if (channel.status === "needs_reauth") {
    helpers.logger.info(`Channel ${channelId} needs_reauth, follow-gate skipped`);
    return;
  }

  const tokens = decryptTokens(channel.token_encrypted);
  const provider = getProvider(channel.platform);

  // No follow graph on this platform → gate open, deliver the followed content.
  let follows = true;
  if (provider.checkFollowsBusiness) {
    try {
      follows = await provider.checkFollowsBusiness(tokens, recipientPlatformId);
    } catch (e) {
      if (e instanceof TokenInvalidError) {
        await markChannelNeedsReauth(channelId, e.message);
        helpers.logger.info(`Channel ${channelId} token invalid on follow check`);
        return;
      }
      throw e; // transient — let graphile retry
    }
  }

  await addJob("outgoing-message", {
    channelId,
    conversationId,
    contactId,
    recipientPlatformId,
    content: follows ? followed : notFollowed,
    sentByRuleId,
    // Deterministic per outcome so a retry of this job cannot double-send the
    // same branch (the outgoing worker claims the key after a successful send).
    idempotencyKey: idempotencyKey ? `${idempotencyKey}:${follows ? "f" : "nf"}` : undefined,
  });

  helpers.logger.info(`follow-gate: follows=${follows} → enqueued ${follows ? "followed" : "not-followed"} reply`);
}
