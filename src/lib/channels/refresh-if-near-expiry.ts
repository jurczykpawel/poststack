import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";
import type { SocialProvider, TokenData } from "@/lib/platforms/base";

/**
 * On-demand OAuth refresh: if `tokens` is within the provider's refresh buffer of expiry, refresh and
 * persist the new token + surfaced `token_expires_at`, returning the fresh tokens. Best-effort — on a
 * refresh failure the existing tokens are returned so the caller can still try (the scheduled scan
 * retries later). Used by every code path that hits a platform API directly (send + email poll) so a
 * short-lived token (e.g. Gmail's 1h) never reaches the API dead.
 */
export async function refreshIfNearExpiry(
  channelId: string,
  provider: SocialProvider,
  tokens: TokenData,
): Promise<{ tokens: TokenData; refreshed: boolean }> {
  if (!provider.requiresTokenRefresh() || typeof tokens.expires_at !== "number") return { tokens, refreshed: false };
  if (Date.now() / 1000 < tokens.expires_at - provider.refreshBufferSeconds()) return { tokens, refreshed: false };
  try {
    const fresh = await provider.refreshToken(tokens);
    await db
      .update(channels)
      .set({
        token_encrypted: encryptTokens(fresh),
        token_expires_at:
          typeof fresh.expires_at === "number" && fresh.expires_at > 0 ? new Date(fresh.expires_at * 1000) : null,
      })
      .where(eq(channels.id, channelId));
    return { tokens: fresh, refreshed: true };
  } catch {
    return { tokens, refreshed: false };
  }
}
