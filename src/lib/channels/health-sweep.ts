import { and, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { inspectMetaToken, MetaTokenError } from "@/lib/platforms/meta-token";
import { markChannelNeedsReauth, markChannelHealthy } from "./health";
import { sanitizeForLog } from "@/lib/api/safe-log";

/** Health-checked platforms (debug_token-backed). Non-Meta channels (e.g. Telegram) are skipped. */
const META_PLATFORMS = ["facebook", "instagram"] as const;

/**
 * Hourly health-check sweep: validate each Meta channel's stored token via debug_token and reconcile
 * the breaker in BOTH directions — trip a healthy channel to needs_reauth on a CONFIRMED bad token,
 * and self-heal a needs_reauth channel the moment debug_token re-confirms the SAME stored token is
 * valid. That recovery matters because a single TRANSIENT `is_valid:false` from Meta would otherwise
 * latch a perfectly healthy channel to needs_reauth forever (needs_reauth channels were excluded from
 * the sweep, and derived channels have no oauth refresh path to recover them). Mirrors the on-demand
 * runHealthCheck. A transient/inconclusive check (network error, Meta hiccup) leaves the channel as-is
 * — it neither trips a healthy one nor recovers a broken one, so an unattended loop never flaps. Each
 * channel is isolated so one failure can't abort the sweep.
 */
export async function sweepChannelHealth(): Promise<{ checked: number; flagged: number; recovered: number }> {
  const rows = await db.query.channels.findMany({
    where: and(inArray(channels.status, ["active", "needs_reauth"]), inArray(channels.platform, [...META_PLATFORMS])),
    columns: { id: true, status: true, token_encrypted: true },
  });

  let checked = 0;
  let flagged = 0;
  let recovered = 0;
  for (const channel of rows) {
    try {
      const token = decryptTokens(channel.token_encrypted).access_token;
      const info = await inspectMetaToken(token); // throws MetaTokenError on confirmed-bad; null = transient
      checked++;
      // Recover ONLY on a positive confirmation (info truthy = valid AND belongs to this app). A null
      // (inconclusive) result never flips a needs_reauth channel back — that would flap on a Meta hiccup.
      if (info && channel.status === "needs_reauth") {
        await markChannelHealthy(channel.id).catch(() => {});
        recovered++;
      }
    } catch (err) {
      if (err instanceof MetaTokenError) {
        // Trip only a channel that is still healthy; one already needs_reauth stays put (no re-alert).
        if (channel.status === "active") {
          await markChannelNeedsReauth(channel.id, err.message).catch(() => {});
          flagged++;
        }
      } else {
        // A decrypt/other error is logged + skipped, not treated as a token failure.
        console.error(`[health-sweep] channel ${channel.id} skipped: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      }
    }
  }
  return { checked, flagged, recovered };
}
