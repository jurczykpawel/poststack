import { prisma } from "@/lib/prisma";

const MAX_ERROR_LEN = 500;

/**
 * Flag a channel as needing re-authentication after a token failure. This opens
 * the breaker: the channel stops auto-sending until reconnected (see REL5).
 */
export async function markChannelNeedsReauth(
  channelId: string,
  error: string,
  now: Date = new Date(),
): Promise<void> {
  await prisma.channel.update({
    where: { id: channelId },
    data: {
      status: "needs_reauth",
      last_error: error.slice(0, MAX_ERROR_LEN),
      last_health_at: now,
    },
  });
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
