import { prisma } from "@/lib/prisma";
import { notifyChannelDown } from "@/lib/notifications/channel-alert";

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
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { status: true, workspace_id: true, platform: true, display_name: true },
  });
  if (!channel) return;

  await prisma.channel.update({
    where: { id: channelId },
    data: {
      status: "needs_reauth",
      last_error: error.slice(0, MAX_ERROR_LEN),
      last_health_at: now,
    },
  });

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

/** Mark a channel healthy (after a successful refresh or reconnect). */
export async function markChannelHealthy(
  channelId: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.channel.update({
    where: { id: channelId },
    data: { status: "active", last_error: null, last_health_at: now },
  });
}
