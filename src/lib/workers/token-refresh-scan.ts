import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { addJob } from "@/lib/queue/client";
import { getProvider } from "@/lib/platforms/registry";
import { decryptTokens } from "@/lib/crypto";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Scan active OAuth channels and enqueue a refresh job for any whose access token is inside its
 * provider's refresh buffer. Shared by the hourly worker cron and the manual
 * `GET /api/cron/token-refresh` trigger, so both paths behave identically.
 *
 * manual_token channels carry a long-lived/System User token and are never refreshed (REL4).
 * Each channel is isolated: a single undecryptable/corrupt token (e.g. after a key rotation) is
 * logged and skipped, never aborting the whole scan and starving every other channel of its
 * refresh job — which would silently cascade into mass token expiry.
 */
export async function scanExpiringTokens(): Promise<{ enqueued: number }> {
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.status, "active"), eq(channels.connection_mode, "oauth")),
    columns: { id: true, platform: true, token_encrypted: true },
  });

  let enqueued = 0;

  for (const channel of rows) {
    try {
      const provider = getProvider(channel.platform);
      if (!provider.requiresTokenRefresh()) continue;

      const tokens = decryptTokens(channel.token_encrypted);
      const expiresAt = tokens.expires_at as number | undefined;
      if (!expiresAt) continue;

      const refreshThreshold = expiresAt - provider.refreshBufferSeconds();
      if (Date.now() / 1000 >= refreshThreshold) {
        await addJob("token-refresh", { channelId: channel.id }, { jobKey: `token-refresh-${channel.id}` });
        enqueued++;
      }
    } catch (err) {
      console.error(
        `[token-refresh-scan] channel ${channel.id} skipped: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  return { enqueued };
}
