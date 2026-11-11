import { and, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { decryptTokens } from "@/lib/crypto";
import { inspectMetaToken, MetaTokenError } from "@/lib/platforms/meta-token";
import { markChannelNeedsReauth, markChannelHealthy } from "./health";
import { recordGrantedScopes } from "./granted-scopes";
import { sanitizeForLog } from "@/lib/api/safe-log";
import { threadsProvider } from "@/lib/providers/threads";
import { TokenInvalidError } from "@/lib/providers/errors";
import { toTokenSet } from "@/lib/providers/token-codec";

/** Health-checked platforms (debug_token-backed). Non-Meta channels (e.g. Telegram) are skipped. */
const META_PLATFORMS = ["facebook", "instagram"] as const;

/** True only when Threads confirms the stored token is dead; transient/other errors are inconclusive. */
export async function threadsTokenDead(channel: { workspace_id: string; platform: string; platform_id: string; token_encrypted: string }): Promise<boolean> {
  try {
    const blob = decryptTokens(channel.token_encrypted, [`ws:${channel.workspace_id}`, "channels.token_encrypted", channel.platform, channel.platform_id]);
    await threadsProvider.healthCheck(toTokenSet(blob));
    return false;
  } catch (err) {
    return err instanceof TokenInvalidError;
  }
}

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
    columns: { platform_id: true, platform: true, id: true, workspace_id: true, status: true, token_encrypted: true },
  });

  let checked = 0;
  let flagged = 0;
  let recovered = 0;
  for (const channel of rows) {
    try {
      const token = decryptTokens(channel.token_encrypted, [`ws:${channel.workspace_id}`, "channels.token_encrypted", channel.platform, channel.platform_id]).access_token;
      if (!token) continue;
      const info = await inspectMetaToken(token); // throws MetaTokenError on confirmed-bad; null = transient
      await recordGrantedScopes(channel.id, info?.scopes, channel.workspace_id, channel.token_encrypted).catch(() => {});
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
  const threads = await db.query.channels.findMany({
    where: and(inArray(channels.status, ["active"]), inArray(channels.platform, ["threads"])),
    columns: { platform_id: true, platform: true, id: true, workspace_id: true, token_encrypted: true },
  });
  for (const channel of threads) {
    checked++;
    if (await threadsTokenDead(channel)) {
      await markChannelNeedsReauth(channel.id, "Threads access token expired — reconnect required").catch(() => {});
      flagged++;
    }
  }
  return { checked, flagged, recovered };
}
