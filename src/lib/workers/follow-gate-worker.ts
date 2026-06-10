import type { JobHelpers } from "graphile-worker";
import type { FollowGateJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, contacts, outboundDeliveries } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError, MessagingPolicyError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth } from "@/lib/channels/health";
import { addJobTx } from "@/lib/queue/client";

/**
 * Follow-gate: re-check (live) whether the recipient follows the business, then
 * enqueue the gated content — the lead magnet when they follow, a re-prompt
 * otherwise. The loop is stateless: each tap of the claim button produces one
 * follow-gate job, so the user drives the loop by following and tapping again.
 * Platforms without a follow graph (Facebook) leave the gate open and deliver.
 *
 * The gate's outcome is resolved ONCE and pinned on the delivery ledger in the same
 * transaction that enqueues the single gated child message: a retry sees the gate
 * already resolved and re-uses the recorded outcome instead of re-checking live, so a follow
 * status that flips between attempts can never enqueue both branches. When the channel is
 * down the gate is parked with its full payload so a drain re-runs it after recovery.
 */
export async function processFollowGate(
  payload: FollowGateJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId, conversationId, contactId, recipientPlatformId, followed, notFollowed, sentByRuleId, idempotencyKey } =
    payload;
  const deliveryKey = idempotencyKey ?? `job:${helpers.job.id}`;
  // One deterministic child key per gate (NOT per outcome), so a retry reuses the same key.
  const childKey = `${deliveryKey}:fg`;

  const prior = await db.query.outboundDeliveries.findFirst({
    where: eq(outboundDeliveries.delivery_key, deliveryKey),
  });
  if (prior?.status === "sent") {
    // The gate was already resolved and its child enqueued — replaying would risk a second
    // branch. Stop.
    helpers.logger.info(`follow-gate ${deliveryKey} already resolved — skipping`);
    return;
  }

  // Park this gate on the ledger as `held` so a drain can replay it after recovery.
  const parkHeld = async (workspaceId: string, lastError: string | null) => {
    const heldPayload = { ...payload, idempotencyKey: deliveryKey };
    await db
      .insert(outboundDeliveries)
      .values({
        delivery_key: deliveryKey,
        workspace_id: workspaceId,
        channel_id: channelId,
        contact_id: contactId,
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
  // A manually paused channel must not even probe the follow graph (a Meta call the pause is
  // meant to forbid) or pin an outcome early. Park the full gate payload so a drain re-runs the
  // live follow-check from scratch after resume (; follow-gate has its own status logic
  // that runDelivery's blockedByPause doesn't cover).
  if (channel.status === "paused") {
    await parkHeld(channel.workspace_id, "channel paused");
    helpers.logger.info(`channel ${channelId} paused, follow-gate held`);
    return;
  }
  // Consent re-check at delivery time: if the contact unsubscribed after the gate was enqueued,
  // don't probe the follow graph or deliver the unlock ( — closes the  enqueue→execute
  // TOCTOU; the sequence worker already re-checks). Dropped (not parked): we must not deliver.
  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, contactId),
    columns: { is_subscribed: true },
  });
  // A missing contact (erased mid-flight) is treated as "do not send", matching the sequence
  // worker — never probe the follow graph or deliver for a contact we can no longer see.
  if (!contact?.is_subscribed) {
    helpers.logger.info(`contact ${contactId} unsubscribed/absent, follow-gate ${deliveryKey} dropped`);
    return;
  }

  const provider = getProvider(channel.platform);

  // No follow graph on this platform → gate open, deliver the followed content.
  let follows = true;
  try {
    // Decrypt INSIDE the catch: an undecryptable token (corrupt / rotated key) throws
    // TokenInvalidError and is handled here as re-auth, exactly like a live token rejection —
    // not left to escape as a generic transient and crash-loop to dead-letter.
    const tokens = decryptChannelToken(channel.token_encrypted);
    if (provider.checkFollowsBusiness) {
      follows = await provider.checkFollowsBusiness(tokens, recipientPlatformId);
    }
  } catch (e) {
    if (e instanceof TokenInvalidError) {
      await parkHeld(channel.workspace_id, e.message);
      await markChannelNeedsReauth(channelId, e.message);
      helpers.logger.info(`channel ${channelId} token invalid on follow check, gate held`);
      return;
    }
    if (e instanceof MessagingPolicyError) {
      // The live follow-check hit a per-recipient PERMANENT failure (e.g. the user deleted their
      // account → subcode 2018001, now classified terminal by  ): we can neither resolve
      // the gate nor ever deliver to this recipient, and a retry can't change that. Record the gate
      // terminally dropped (no child enqueued, no retry) instead of dead-lettering every attempt
      //.
      await db
        .insert(outboundDeliveries)
        .values({
          delivery_key: deliveryKey,
          workspace_id: channel.workspace_id,
          channel_id: channelId,
          contact_id: contactId,
          task_name: "follow-gate",
          payload: { ...payload, idempotencyKey: deliveryKey },
          status: "expired",
          last_error: e.message,
          attempts: 1,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: outboundDeliveries.delivery_key,
          set: { status: "expired", last_error: e.message, updated_at: new Date() },
        });
      helpers.logger.info(`follow-gate ${deliveryKey} dropped — ${e.message} (recipient unreachable)`);
      return;
    }
    throw e; // transient — let graphile retry
  }

  // Resolve the outcome ONCE: pin it on the ledger and enqueue the single gated child in the
  // same transaction. A retry hits the `sent` short-circuit above and never re-checks live,
  // so a flipped follow status cannot enqueue the other branch. The child carries a single
  // deterministic key (a graphile job-key dedup as a second line of defence).
  await db.transaction(async (tx) => {
    const resolvedPayload = { ...payload, idempotencyKey: deliveryKey, follows };
    await tx
      .insert(outboundDeliveries)
      .values({
        delivery_key: deliveryKey,
        workspace_id: channel.workspace_id,
        channel_id: channelId,
        contact_id: contactId,
        task_name: "follow-gate",
        payload: resolvedPayload,
        status: "sent",
        attempts: 1,
        // Write updated_at app-clock on this fresh terminal INSERT too: without it the column
        // takes its DB-clock DEFAULT now(), which would be the one terminal row whose updated_at is
        // NOT app-clock — making the retention sweep's plain-Date cutoff over-prune it off-pin.
        updated_at: new Date(),
      })
      .onConflictDoUpdate({
        target: outboundDeliveries.delivery_key,
        set: { status: "sent", payload: resolvedPayload, last_error: null, updated_at: new Date() },
      });
    await addJobTx(
      tx,
      "outgoing-message",
      {
        channelId,
        conversationId,
        contactId,
        recipientPlatformId,
        content: follows ? followed : notFollowed,
        sentByRuleId,
        idempotencyKey: childKey,
      },
      { jobKey: childKey },
    );
  });

  helpers.logger.info(`follow-gate ${deliveryKey}: follows=${follows} → enqueued ${follows ? "followed" : "not-followed"} reply`);
}
