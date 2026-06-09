import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { notifyChannelDown } from "@/lib/notifications/channel-alert";
import { addJobTx } from "@/lib/queue/client";

/** An open Drizzle transaction (the callback arg of db.transaction). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_ERROR_LEN = 500;

/**
 * Flag a channel as needing re-authentication after a token failure. This opens
 * the breaker: the channel stops auto-sending until reconnected (see REL5).
 * Fires a notification once, only on the ok→down transition (no alert storm).
 */
export async function markChannelNeedsReauth(
  channelId: string,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { status: true, workspace_id: true, platform: true, display_name: true },
  });
  if (!channel) return;

  await db
    .update(channels)
    .set({
      status: "needs_reauth",
      last_error: error.slice(0, MAX_ERROR_LEN),
      last_health_at: now,
    })
    .where(eq(channels.id, channelId));

  // Notify only when the channel was previously healthy (one alert per outage).
  if (channel.status !== "needs_reauth") {
    await notifyChannelDown({
      workspaceId: channel.workspace_id,
      channelId,
      platform: channel.platform,
      displayName: channel.display_name,
      reason: error,
    });
  }
}

/**
 * Mark a channel healthy (after a successful refresh or reconnect). When this
 * closes an open breaker (needs_reauth → active), enqueue a drain to replay any
 * outbound parked while the channel was down (REL5).
 *
 * Accepts an optional executor so a caller can fold the flip into a larger transaction — e.g. the
 * token-refresh worker commits the new token AND this flip together, so a failed drain enqueue
 * rolls the token write back too. With no executor it opens its own transaction.
 */
export async function markChannelHealthy(
  channelId: string,
  now: Date = new Date(),
  tx?: Tx,
): Promise<void> {
  // No transaction supplied → open one and recurse, so the body below always runs against a real
  // transaction (and a caller-supplied one folds this flip into its own atomic unit, ).
  if (!tx) {
    await db.transaction((t) => markChannelHealthy(channelId, now, t));
    return;
  }

  const channel = await tx.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { status: true },
  });

  // A manual pause is operator intent and must outlive a successful health check / refresh:
  // record that the check passed, but do NOT flip status back to active.
  if (channel?.status === "paused") {
    await tx.update(channels).set({ last_error: null, last_health_at: now }).where(eq(channels.id, channelId));
    return;
  }

  // Flip to active and enqueue the recovery drain in ONE transaction (a transactional
  // outbox): if the drain enqueue fails the status flip rolls back too, so the channel stays
  // needs_reauth and the next retry re-detects the transition and re-drains. Held messages
  // can never strand behind a channel that recovered to `active` without a drain.
  await tx
    .update(channels)
    .set({ status: "active", last_error: null, last_health_at: now })
    .where(eq(channels.id, channelId));
  if (channel?.status === "needs_reauth") {
    await addJobTx(tx, "drain-channel", { channelId }, { jobKey: `drain-channel:${channelId}` });
  }
}
