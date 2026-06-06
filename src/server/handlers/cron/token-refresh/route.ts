import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { addJob } from "@/lib/queue/client";
import { getProvider } from "@/lib/platforms/registry";
import { decryptTokens } from "@/lib/crypto";

export const runtime = "nodejs";

/**
 * Cron job: scan for channels with expiring tokens and enqueue refresh jobs.
 * Call hourly: GET /api/cron/token-refresh
 * Protected by CRON_SECRET header (timing-safe comparison).
 */
export async function GET(request: Request) {
  const secret = request.headers.get("x-cron-secret") ?? "";
  if (!env.CRON_SECRET || secret.length !== env.CRON_SECRET.length ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(env.CRON_SECRET))) {
    return new Response("Forbidden", { status: 403 });
  }

  const channels = await prisma.channel.findMany({
    // manual_token channels carry a long-lived token and are never refreshed (REL4).
    where: { status: "active", connection_mode: "oauth" },
    select: { id: true, platform: true, token_encrypted: true },
  });

  let enqueued = 0;

  for (const channel of channels) {
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
  }

  return Response.json({ enqueued });
}
