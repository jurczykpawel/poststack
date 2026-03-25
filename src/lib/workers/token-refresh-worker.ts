import type { Job } from "bullmq";
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
  job: Job<TokenRefreshJob>
): Promise<void> {
  const { channelId } = job.data;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, platform: true, token_encrypted: true, is_active: true },
  });

  if (!channel || !channel.is_active) {
    await job.log(`Channel ${channelId} not found or inactive, skipping`);
    return;
  }

  const provider = getProvider(channel.platform);
  if (!provider.requiresTokenRefresh()) {
    await job.log(`Platform ${channel.platform} does not require token refresh`);
    return;
  }

  const currentTokens = decryptTokens(channel.token_encrypted);
  const refreshedTokens = await provider.refreshToken(currentTokens);

  await prisma.channel.update({
    where: { id: channelId },
    data: { token_encrypted: encryptTokens(refreshedTokens) },
  });

  await job.log(`Token refreshed for channel=${channelId}`);
}
