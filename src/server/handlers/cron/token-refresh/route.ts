import { createHash, timingSafeEqual } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { env } from "@/lib/env";
import { addJob } from "@/lib/queue/client";
import { getProvider } from "@/lib/platforms/registry";
import { decryptTokens } from "@/lib/crypto";
import { sanitizeForLog } from "@/lib/api/safe-log";

export const runtime = "nodejs";

/**
 * Cron job: scan for channels with expiring tokens and enqueue refresh jobs.
 * Call hourly: GET /api/cron/token-refresh
 * Protected by CRON_SECRET header (timing-safe comparison).
 */
export async function GET(request: Request) {
  const secret = request.headers.get("x-cron-secret") ?? "";
  // Compare SHA-256 digests (always equal length) so the check is constant-time and does not
  // short-circuit on a length mismatch, which would leak CRON_SECRET's length.
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (!env.CRON_SECRET || !timingSafeEqual(digest(secret), digest(env.CRON_SECRET))) {
    return new Response("Forbidden", { status: 403 });
  }

  // manual_token channels carry a long-lived token and are never refreshed (REL4).
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.status, "active"), eq(channels.connection_mode, "oauth")),
    columns: { id: true, platform: true, token_encrypted: true },
  });

  let enqueued = 0;

  for (const channel of rows) {
    // Isolate each channel: a single undecryptable/corrupt token (e.g. after a key rotation)
    // must not abort the whole scan and starve every other channel of its refresh job — which
    // would silently cascade into mass token expiry. Best-effort: log and continue.
    try {
      const provider = getProvider(channel.platform);
      if (!provider.requiresTokenRefresh()) continue;

      const tokens = decryptTokens(channel.token_encrypted);
      const expiresAt = tokens.expires_at as number | undefined;
      if (!expiresAt) continue;

      const bufferSeconds = provider.refreshBufferSeconds();
      const refreshThreshold = expiresAt - bufferSeconds;

      if (Date.now() / 1000 >= refreshThreshold) {
        await addJob(
          "token-refresh",
          { channelId: channel.id },
          { jobKey: `token-refresh-${channel.id}` }
        );
        enqueued++;
      }
    } catch (err) {
      console.error(`[cron/token-refresh] channel ${channel.id} skipped: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }

  return Response.json({ enqueued });
}
