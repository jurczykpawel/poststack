import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { inspectMetaToken, MetaTokenError } from "@/lib/platforms/meta-token";
import { markChannelNeedsReauth } from "./health";
import { sanitizeForLog } from "@/lib/api/safe-log";

/** Health-checked platforms (debug_token-backed). Non-Meta channels (e.g. Telegram) are skipped. */
const META_PLATFORMS = ["facebook", "instagram"] as const;

/**
 * Hourly health-check sweep: validate each active Meta channel's stored token via debug_token and
 * trip the breaker (needs_reauth) on a CONFIRMED bad token — catching a revoked/expired token before
 * the next send dead-letters, and surfacing it in the panel + an alert. A transient/inconclusive
 * check (network error, Meta hiccup) is skipped, never flipping a healthy channel. Each channel is
 * isolated so one failure can't abort the sweep.
 */
export async function sweepChannelHealth(): Promise<{ checked: number; flagged: number }> {
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.status, "active"), inArray(channels.platform, [...META_PLATFORMS])),
    columns: { id: true, token_encrypted: true },
  });

  let checked = 0;
  let flagged = 0;
  for (const channel of rows) {
    try {
      const token = decryptTokens(channel.token_encrypted).access_token;
      await inspectMetaToken(token); // null (transient/creds missing) → leave the channel alone
      checked++;
    } catch (err) {
      if (err instanceof MetaTokenError) {
        await markChannelNeedsReauth(channel.id, err.message).catch(() => {});
        flagged++;
      } else {
        // A decrypt/other error is logged + skipped, not treated as a token failure.
        console.error(`[health-sweep] channel ${channel.id} skipped: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      }
    }
  }
  return { checked, flagged };
}
