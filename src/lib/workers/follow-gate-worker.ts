import type { JobHelpers } from "graphile-worker";
import type { FollowGateJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, outboundDeliveries } from "@/db/schema";
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
 *
 * When the channel is down (needs_reauth / dead token) the gate is parked on the
 * outbound-delivery ledger with its full payload, so a drain re-dispatches the exact
 * follow-gate operation once the channel recovers rather than dropping it.
 */
export async function processFollowGate(
  payload: FollowGateJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, contactId, recipientPlatformId, followed, notFollowed, sentByRuleId, idempotencyKey } =
    payload;
  const deliveryKey = idempotencyKey ?? `job:${helpers.job.id}`;

  // Park this gate on the ledger as `held` so a drain can replay it after recovery.
  const parkHeld = async (workspaceId: string, lastError: string | null) => {
    const heldPayload = { ...payload, idempotencyKey: deliveryKey };
    await db
      .insert(outboundDeliveries)
      .values({
        delivery_key: deliveryKey,
        workspace_id: workspaceId,
        channel_id: channelId,
        task_name: "follow-gate",
        payload: heldPayload,
        status: "held",
        last_error: lastError,
        attempts: 1,
      })
      .onConflictDoUpdate({
        target: outboundDeliveries.delivery_key,
        set: { status: "held", payload: heldPayload, last_error: lastError, updated_at: new Date() },
      });
  };

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, workspace_id: true, platform: true, token_encrypted: true, status: true },
  });

  if (!channel || channel.status === "disabled") {
    throw new Error(`Channel ${channelId} not found or disabled`);
  }
  if (channel.status === "needs_reauth") {
    await parkHeld(channel.workspace_id, "channel needs_reauth");
    helpers.logger.info(`channel ${channelId} needs_reauth, follow-gate held`);
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
        await parkHeld(channel.workspace_id, e.message);
        await markChannelNeedsReauth(channelId, e.message);
        helpers.logger.info(`channel ${channelId} token invalid on follow check, gate held`);
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

  // If this gate was parked and replayed by a drain, close out the held ledger row so a
  // later drain doesn't re-dispatch it. A no-op for a fresh (never-parked) gate.
  await db
    .update(outboundDeliveries)
    .set({ status: "sent", updated_at: new Date() })
    .where(eq(outboundDeliveries.delivery_key, deliveryKey));

  helpers.logger.info(`follow-gate: follows=${follows} → enqueued ${follows ? "followed" : "not-followed"} reply`);
}
