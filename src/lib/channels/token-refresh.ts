import type { JobHelpers } from "graphile-worker";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import type { TokenData } from "@/lib/platforms/base";
import { decryptTokens, encryptTokens } from "@/lib/crypto";
import { getProvider, isProvider } from "@/lib/providers";
import { TokenInvalidError } from "@/lib/providers/errors";
import { toTokenSet, fromTokenSet } from "@/lib/providers/token-codec";
import type { TokenSet } from "@/lib/providers/types";
import { redactSecrets } from "@/lib/redact";
import { markChannelHealthy, markChannelNeedsReauth } from "./health";

/**
 * Overlay ONLY the refreshed credential fields (access/refresh token + expiry) onto the channel's
 * CURRENT decrypted token blob, so a refresh never drops the non-credential fields a blob also carries
 * (messaging_token, messaging_token_expires_at, page_id, user_access_token, …). `fromTokenSet` returns
 * only the 3 credential fields and would otherwise clobber everything else when persisted. Mirrors the
 * merge philosophy of `mergeFbTokenFields` (token-refresh-worker.ts): own only your fields, keep the rest.
 */
export function mergeRefreshedBlob(currentBlob: TokenData, refreshed: TokenSet): TokenData {
  const cred = fromTokenSet(refreshed);
  return {
    ...currentBlob,
    access_token: cred.access_token,
    // Preserve the existing refresh token when the refreshed set carries none.
    refresh_token: refreshed.refreshToken ?? currentBlob.refresh_token,
    expires_at: cred.expires_at,
  };
}

/**
 * Refresh a channel's OAuth token via its publish provider (one token-keeper for publish + inbound).
 * manual_token isn't on a refresh cycle; derived is re-minted by the source-sync. Converts the stored
 * TokenData ↔ the provider's TokenSet at the boundary.
 */
export async function processTokenRefresh(
  payload: { channelId: string },
  helpers: JobHelpers,
): Promise<void> {
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, payload.channelId), isNull(channels.deleted_at)),
  });
  if (!channel || channel.status === "disabled") return;
  if (channel.connection_mode === "manual_token" || channel.connection_mode === "derived") return;
  if (!isProvider(channel.platform)) return;
  const provider = getProvider(channel.platform);
  if (!provider.requiresTokenRefresh()) return;

  const currentBlob = decryptTokens(channel.token_encrypted);
  const current = toTokenSet(currentBlob);
  let refreshed;
  try {
    refreshed = await provider.refreshToken(current);
  } catch (err) {
    if (err instanceof TokenInvalidError) {
      await markChannelNeedsReauth(payload.channelId, err.message);
      return; // retry won't help
    }
    // PSA53: sanitize the rethrown message in place — graphile logs it outside the redact chokepoint.
    if (err instanceof Error) err.message = redactSecrets(err.message);
    throw err; // transient — allow retry
  }

  // Preserve the existing refresh token when the provider returns none (#1383 lesson).
  const merged = { ...refreshed, refreshToken: refreshed.refreshToken ?? current.refreshToken };
  // Merge the refreshed credential fields OVER the current blob — never replace the whole blob with
  // just the 3 credential fields (would drop messaging_token / page_id / user_access_token).
  await db
    .update(channels)
    .set({
      token_encrypted: encryptTokens(mergeRefreshedBlob(currentBlob, merged)),
      token_expires_at: merged.expiresAt ? new Date(merged.expiresAt) : null,
      updated_at: new Date(),
    })
    .where(eq(channels.id, payload.channelId));
  await markChannelHealthy(payload.channelId); // recovers needs_reauth; leaves paused/active (AUD40)
  helpers.logger.info(`token refreshed for channel ${payload.channelId}`);
}
