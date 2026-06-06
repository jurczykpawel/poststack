import type { JobHelpers } from "graphile-worker";
import type { TokenRefreshJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens, encryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { markChannelNeedsReauth, markChannelHealthy } from "@/lib/channels/health";

/**
 * Refresh an expiring platform access token.
 *
 * 1. Load channel
 * 2. Decrypt current tokens
 * 3. Call platform.refreshToken()
 * 4. Re-encrypt and save (or flag the channel for re-auth if the token is dead)
 */
export async function processTokenRefresh(
  payload: TokenRefreshJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId } = payload;

  const channel = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { id: true, platform: true, token_encrypted: true, status: true, connection_mode: true },
  });

  if (!channel || channel.status === "disabled") {
    helpers.logger.info(`Channel ${channelId} not found or disabled, skipping`);
    return;
  }

  // Manual long-lived / System User tokens are not on a refresh cycle (REL4).
  if (channel.connection_mode === "manual_token") {
    helpers.logger.info(`Channel ${channelId} uses a manual long-lived token, skipping refresh`);
    return;
  }

  const provider = getProvider(channel.platform);
  if (!provider.requiresTokenRefresh()) {
    helpers.logger.info(`Platform ${channel.platform} does not require token refresh`);
    return;
  }

  const currentTokens = decryptTokens(channel.token_encrypted);

  let refreshedTokens;
  try {
    refreshedTokens = await provider.refreshToken(currentTokens);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      // Dead token — flag for re-auth and stop. Retrying won't help.
      await markChannelNeedsReauth(channelId, err.message);
      helpers.logger.info(`Channel ${channelId} token invalid, flagged needs_reauth`);
      return;
    }
    throw err; // transient — allow retry
  }

  await db.update(channels).set({ token_encrypted: encryptTokens(refreshedTokens) }).where(eq(channels.id, channelId));
  await markChannelHealthy(channelId);

  helpers.logger.info(`Token refreshed for channel=${channelId}`);
}
