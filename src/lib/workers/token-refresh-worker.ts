import type { JobHelpers } from "graphile-worker";
import type { Platform } from "@/db/schema";
import type { TokenRefreshJob } from "@/lib/queue/types";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { encryptTokens, decryptTokens } from "@/lib/crypto";
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
  // Race-safe persist (lost-update guard). The HTTP refresh above ran against a pre-call snapshot of
  // the blob; a CONCURRENT messaging-token refresh on the same row may have advanced messaging_token
  // in the meantime. Decrypting that stale snapshot and writing the WHOLE blob back would revert the
  // freshly-refreshed messaging token (silent IG-DM death). So inside the transaction: lock the row,
  // RE-DECRYPT the LATEST stored blob, overlay only THIS writer's own fields (the refreshed FB
  // access/user token + expiry), and preserve the just-read messaging fields a concurrent writer may
  // have committed. The flip stays in the same tx so token + status commit atomically.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ token_encrypted: channels.token_encrypted })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for("update");
    const merged = mergeFbTokenFields(row?.token_encrypted, refreshedTokens);
    await tx
      .update(channels)
      .set({ token_encrypted: encryptTokens(merged), token_expires_at: refreshedExpiresAt })
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

  // Race-safe persist (lost-update guard). `blob` is a pre-HTTP snapshot; a CONCURRENT FB-token
  // refresh on the same row may have advanced access_token/user_access_token/expires_at while the
  // refreshMessagingToken HTTP call was in flight. Writing this stale snapshot back would revert that
  // FB token. So inside the transaction: lock the row, RE-DECRYPT the LATEST stored blob, overlay
  // ONLY this writer's own fields (messaging_token + in-blob messaging_token_expires_at), re-encrypt,
  // and advance the plaintext death-clock column the scan reads. Every other field (incl. the
  // FB page/user token a concurrent writer just committed) is preserved.
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ token_encrypted: channels.token_encrypted })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for("update");
    const latest = row ? decryptTokens(row.token_encrypted) : blob;
    latest.messaging_token = refreshed.token;
    latest.messaging_token_expires_at = refreshed.expiresAt;
    await tx
      .update(channels)
      .set({
        token_encrypted: encryptTokens(latest),
        messaging_token_expires_at: new Date(refreshed.expiresAt * 1000),
      })
      .where(eq(channels.id, channelId));
  });

  helpers.logger.info(`Messaging token refreshed for channel=${channelId}`);
}

/**
 * Build the blob the FB-token writer persists, race-safe against a concurrent messaging refresh.
 *
 * Starts from the just-refreshed token object (carrying the new FB access/user token + expiry) but
 * overlays the messaging fields read from the LATEST stored blob under the row lock — so a
 * messaging_token a concurrent refresh advanced is never reverted by the FB write. The messaging
 * fields are the ONLY ones the messaging writer owns, so re-applying exactly those is the symmetric
 * counterpart to that writer re-applying only its own fields.
 *
 * If the latest stored blob can't be decrypted (should not happen — a concurrent writer wrote valid
 * ciphertext), fall back to writing just the refreshed FB tokens rather than skipping the recovery.
 */
function mergeFbTokenFields(
  latestEncrypted: string | undefined,
  refreshedTokens: import("@/lib/platforms/base").TokenData,
): import("@/lib/platforms/base").TokenData {
  const merged = { ...refreshedTokens };
  if (!latestEncrypted) return merged;
  let latest;
  try {
    latest = decryptTokens(latestEncrypted);
  } catch {
    return merged;
  }
  if ("messaging_token" in latest) merged.messaging_token = latest.messaging_token;
  else delete merged.messaging_token;
  if ("messaging_token_expires_at" in latest) merged.messaging_token_expires_at = latest.messaging_token_expires_at;
  else delete merged.messaging_token_expires_at;
  return merged;
}
