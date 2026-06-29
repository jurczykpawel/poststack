import type { JobHelpers } from "graphile-worker";
import type { Platform } from "@/db/schema";
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

  // IGML6: the Instagram-Login messaging token runs on its OWN 60-day clock, refreshed via a separate
  // provider method and persisted to its own column. Branch here BEFORE the requiresTokenRefresh()
  // gate (which governs the main FB token only).
  if (payload.kind === "messaging") {
    await refreshMessagingToken(channelId, channel.platform, channel.token_encrypted, helpers);
    return;
  }

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

/**
 * IGML6 (life-support): refresh the Instagram-Login IGQW `messaging_token` on its own 60-day clock.
 *
 * 1. Decrypt the blob (an undecryptable token → TokenInvalidError, handled like a dead token).
 * 2. provider.refreshMessagingToken(currentToken).
 * 3. On success: write the new token back INTO the blob (preserving the FB page token + every other
 *    field) and advance BOTH the in-blob `messaging_token_expires_at` (unix seconds) and the plaintext
 *    `messaging_token_expires_at` column the scan reads.
 * 4. On a dead/undecryptable token: flag the channel needs_reauth with reason `messaging_token_expired`
 *    — markChannelNeedsReauth fires the channel-down alert (REL3) on the ok→down transition. Retrying
 *    won't help, so stop. A transient error re-throws to let the job retry.
 */
async function refreshMessagingToken(
  channelId: string,
  platform: Platform,
  tokenEncrypted: string,
  helpers: JobHelpers,
): Promise<void> {
  const provider = getProvider(platform);
  if (typeof provider.refreshMessagingToken !== "function") {
    helpers.logger.info(`Platform ${platform} has no messaging token to refresh, skipping`);
    return;
  }

  let blob;
  let refreshed;
  try {
    // Decrypt INSIDE the catch (see processTokenRefresh): a corrupt/rotated-key token throws
    // TokenInvalidError and is flagged here, not left to dead-letter the job with no signal.
    blob = decryptChannelToken(tokenEncrypted);
    const messagingToken = typeof blob.messaging_token === "string" ? blob.messaging_token : "";
    if (!messagingToken) {
      // The expiry column was set but the secret is gone (shouldn't happen) — nothing to refresh.
      helpers.logger.info(`Channel ${channelId} has no messaging token, skipping`);
      return;
    }
    refreshed = await provider.refreshMessagingToken(messagingToken);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      // Dead/undecryptable messaging token (>60d, refresh rejected) — flag for re-auth + alert, stop.
      await markChannelNeedsReauth(channelId, "messaging_token_expired");
      helpers.logger.info(`Channel ${channelId} messaging token invalid, flagged needs_reauth`);
      return;
    }
    throw err; // transient — allow retry
  }

  // Persist the refreshed messaging token: re-encrypt the blob with the new secret + advance both the
  // in-blob unix expiry and the plaintext death-clock column the scan reads. The FB page token and
  // every other blob field are preserved.
  blob.messaging_token = refreshed.token;
  blob.messaging_token_expires_at = refreshed.expiresAt;
  await db
    .update(channels)
    .set({
      token_encrypted: encryptTokens(blob),
      messaging_token_expires_at: new Date(refreshed.expiresAt * 1000),
    })
    .where(eq(channels.id, channelId));

  helpers.logger.info(`Messaging token refreshed for channel=${channelId}`);
}
