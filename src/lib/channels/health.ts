import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { notifyChannelDown } from "@/lib/notifications/channel-alert";
import { addJob } from "@/lib/queue/client";

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
 */
export async function markChannelHealthy(
  channelId: string,
  now: Date = new Date(),
): Promise<void> {
  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { status: true },
  });

  await db
    .update(channels)
    .set({ status: "active", last_error: null, last_health_at: now })
    .where(eq(channels.id, channelId));

  if (channel?.status === "needs_reauth") {
    await addJob("drain-channel", { channelId });
  }
}
