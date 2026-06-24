import type { JobHelpers } from "graphile-worker";
import type { TokenRefreshJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";
import { decryptChannelToken } from "@/lib/channels/tokens";
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

  // Manual long-lived / System User tokens are not on a refresh cycle.
  if (channel.connection_mode === "manual_token") {
    helpers.logger.info(`Channel ${channelId} uses a manual long-lived token, skipping refresh`);
    return;
  }

  const provider = getProvider(channel.platform);
  if (!provider.requiresTokenRefresh()) {
    helpers.logger.info(`Platform ${channel.platform} does not require token refresh`);
    return;
  }

  let refreshedTokens;
  try {
    // Decrypt INSIDE the catch: an undecryptable stored token (corrupt / rotated key) throws
    // TokenInvalidError and is flagged for re-auth here, exactly like a dead token the provider
    // rejects — not left to escape and dead-letter the refresh job per-channel with no flag.
    const currentTokens = decryptChannelToken(channel.token_encrypted);
    refreshedTokens = await provider.refreshToken(currentTokens);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      // Dead/undecryptable token — flag for re-auth and stop. Retrying won't help.
      await markChannelNeedsReauth(channelId, err.message);
      helpers.logger.info(`Channel ${channelId} token invalid, flagged needs_reauth`);
      return;
    }
    throw err; // transient — allow retry
  }

  // Persist the new token AND flip the channel healthy in ONE transaction. A crash/failure
  // between them previously left the new token saved but the status stuck needs_reauth with no
  // drain enqueued — held messages would strand behind a token that had actually recovered.
  // Surface the refreshed expiry too: token_expires_at drives the UI badge + the expiry scan, so a
  // refresh that updated only the encrypted blob left the column frozen at the connect-time value.
  const refreshedExpiresAt =
    typeof refreshedTokens.expires_at === "number" && refreshedTokens.expires_at > 0
      ? new Date(refreshedTokens.expires_at * 1000)
      : null;
  await db.transaction(async (tx) => {
    await tx
      .update(channels)
      .set({ token_encrypted: encryptTokens(refreshedTokens), token_expires_at: refreshedExpiresAt })
      .where(eq(channels.id, channelId));
    await markChannelHealthy(channelId, new Date(), tx);
  });

  helpers.logger.info(`Token refreshed for channel=${channelId}`);
}
