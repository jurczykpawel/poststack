import type { JobHelpers } from "graphile-worker";
import type { TokenRefreshJob } from "@/lib/queue/types";
import { prisma } from "@/lib/prisma";
import { decryptTokens, encryptTokens } from "@/lib/crypto";
import { getProvider } from "@/lib/platforms/registry";

/**
 * Refresh an expiring platform access token.
 *
 * 1. Load channel
 * 2. Decrypt current tokens
 * 3. Call platform.refreshToken()
 * 4. Re-encrypt and save
 */
export async function processTokenRefresh(
  payload: TokenRefreshJob,
  helpers: JobHelpers,
): Promise<void> {
  const { channelId } = payload;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, platform: true, token_encrypted: true, is_active: true },
  });

  if (!channel || !channel.is_active) {
    helpers.logger.info(`Channel ${channelId} not found or inactive, skipping`);
    return;
  }

  const provider = getProvider(channel.platform);
  if (!provider.requiresTokenRefresh()) {
    helpers.logger.info(`Platform ${channel.platform} does not require token refresh`);
    return;
  }

  const currentTokens = decryptTokens(channel.token_encrypted);
  const refreshedTokens = await provider.refreshToken(currentTokens);

  await prisma.channel.update({
    where: { id: channelId },
    data: { token_encrypted: encryptTokens(refreshedTokens) },
  });

  helpers.logger.info(`Token refreshed for channel=${channelId}`);
}
