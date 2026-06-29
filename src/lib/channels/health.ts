import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { dispatchAlert } from "@/lib/notifications/alert";
import { addJobTx } from "@/lib/queue/client";
import { emitEventNow } from "@/lib/events";
import { redactSecrets } from "@/lib/redact";

/** An open Drizzle transaction (the callback arg of db.transaction). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MAX_ERROR_LEN = 500;

/**
 * Flag a channel as needing re-authentication after a token failure. This opens
 * the breaker: the channel stops auto-sending until reconnected.
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

  // PSA13: strip any token/secret echoed back in the provider error BEFORE it is persisted to
  // last_error / needs_reauth_reason (both named redaction targets) or emitted in the alert detail.
  const redacted = redactSecrets(error);
  const reason = redacted.slice(0, MAX_ERROR_LEN);
  await db
    .update(channels)
    .set({
      status: "needs_reauth",
      last_error: reason,
      // Mirror the reason into needs_reauth_reason — the field the dashboard/inbox surface to the
      // operator (last_error is the diagnostic log). Previously left null here, so every reauth path
      // fell back to a generic "Token needs reauthorization" in the UI.
      needs_reauth_reason: reason,
      last_health_at: now,
    })
    .where(eq(channels.id, channelId));

  // Notify only when the channel was previously healthy (one alert per outage). The throttle in
  // dispatchAlert is a second backstop against a storm.
  if (channel.status !== "needs_reauth") {
    await dispatchAlert({
      type: "channel_reauth",
      workspaceId: channel.workspace_id,
      channelId,
      platform: channel.platform,
      displayName: channel.display_name,
      detail: redacted,
    });
    // Surface the outage in the activity feed (/events). Best-effort: never break the health flip.
    await emitEventNow(
      channel.workspace_id,
      "channel.needs_reauth",
      { type: "channel", id: channelId },
      { platform: channel.platform, displayName: channel.display_name },
    ).catch(() => {});
  }
}

/**
 * Mark a channel healthy (after a successful refresh or reconnect). When this
 * closes an open breaker (needs_reauth → active), enqueue a drain to replay any
 * outbound parked while the channel was down.
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
  // transaction (and a caller-supplied one folds this flip into its own atomic unit).
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
    await tx.update(channels).set({ last_error: null, needs_reauth_reason: null, last_health_at: now }).where(eq(channels.id, channelId));
    return;
  }

  // Flip to active and enqueue the recovery drain in ONE transaction (a transactional
  // outbox): if the drain enqueue fails the status flip rolls back too, so the channel stays
  // needs_reauth and the next retry re-detects the transition and re-drains. Held messages
  // can never strand behind a channel that recovered to `active` without a drain.
  await tx
    .update(channels)
    .set({ status: "active", last_error: null, needs_reauth_reason: null, last_health_at: now })
    .where(eq(channels.id, channelId));
  if (channel?.status === "needs_reauth") {
    await addJobTx(tx, "drain-channel", { channelId }, { jobKey: `drain-channel:${channelId}` });
  }
}
