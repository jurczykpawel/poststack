import { and, eq, gt, isNotNull, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { addJob } from "@/lib/queue/client";
import { dispatchAlert } from "@/lib/notifications/alert";
import { getProvider } from "@/lib/platforms/registry";
import { decryptTokens } from "@/lib/crypto";
import { sanitizeForLog } from "@/lib/api/safe-log";

/**
 * Scan active OAuth channels and enqueue a refresh job for any whose access token is inside its
 * provider's refresh buffer. Shared by the hourly worker cron and the manual
 * `GET /api/cron/token-refresh` trigger, so both paths behave identically.
 *
 * manual_token channels carry a long-lived/System User token and are never refreshed.
 * Each channel is isolated: a single undecryptable/corrupt token (e.g. after a key rotation) is
 * logged and skipped, never aborting the whole scan and starving every other channel of its
 * refresh job — which would silently cascade into mass token expiry.
 */
export async function scanExpiringTokens(): Promise<{ enqueued: number }> {
  // NOTE (perf): this decrypts every active OAuth token hourly just to read expires_at.
  // Fine at a handful of channels; at managed-hosting scale add a plaintext channels.token_expires_at
  // column (written wherever the token is stored) and filter DB-side (WHERE token_expires_at < now()
  // + buffer), decrypting only the near-expiry rows. Deferred until the channel count makes it matter.
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

  // IGML6 (life-support): the Instagram-Login messaging token (IGQW `messaging_token`) lives on its
  // OWN 60-day clock, tracked by the PLAINTEXT messaging_token_expires_at column — independent of the
  // FB page/user token above. A dead one silently kills IG DMs (a real channel died exactly this way),
  // so it MUST be refreshed proactively. Scanned DB-side (no decrypt needed — the death-clock is
  // plaintext) and enqueued on its own jobKey + `kind: "messaging"`, so it never collides with the
  // oauth refresh job above and the two clocks stay fully independent. Buffer = the IG provider's
  // refreshBufferSeconds() (~10 days) — single source of truth. Already-expired rows are included so a
  // (still-refreshable) just-lapsed token is recovered, and a truly dead one flips to needs_reauth.
  const igBufferSeconds = getProvider("instagram").refreshBufferSeconds();
  const messagingThreshold = new Date(Date.now() + igBufferSeconds * 1000);
  const messagingRows = await db.query.channels.findMany({
    where: and(
      eq(channels.status, "active"),
      isNotNull(channels.messaging_token_expires_at),
      lte(channels.messaging_token_expires_at, messagingThreshold),
    ),
    columns: { id: true },
  });

  for (const channel of messagingRows) {
    await addJob(
      "token-refresh",
      { channelId: channel.id, kind: "messaging" },
      { jobKey: `messaging-token-refresh-${channel.id}` },
    );
    enqueued++;
  }

  // REAUTH2 (final reminder): the ok→down `channel_reauth` alert fired ~7 days out, then the channel
  // dropped out of the scan (status != active) and went silent. A slow operator can miss that one mail
  // and lose the channel at expiry — LinkedIn especially, whose token can't be refreshed programmatically
  // (invalid_grant) so a manual reconnect is the ONLY recovery. Send ONE higher-priority nudge in the
  // last 24h before the hard `token_expires_at`. Guarded once per expiry via metadata, keyed to the
  // exact expiry timestamp so a reconnect (new token, new expiry) self-resets it — no flag to clear.
  const reminderWindow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const reauthRows = await db.query.channels.findMany({
    where: and(
      eq(channels.status, "needs_reauth"),
      eq(channels.connection_mode, "oauth"),
      isNotNull(channels.token_expires_at),
      gt(channels.token_expires_at, new Date()),
      lte(channels.token_expires_at, reminderWindow),
    ),
    columns: {
      id: true, platform: true, display_name: true, workspace_id: true,
      token_expires_at: true, metadata: true, needs_reauth_reason: true,
    },
  });
  for (const ch of reauthRows) {
    const expiresAtIso = ch.token_expires_at!.toISOString();
    const meta = (ch.metadata ?? {}) as Record<string, unknown>;
    if (meta.finalReauthReminderForExpiry === expiresAtIso) continue; // already nudged for this expiry
    const daysLeft = Math.max(0, Math.ceil((ch.token_expires_at!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    await dispatchAlert({
      type: "channel_reauth_urgent",
      workspaceId: ch.workspace_id,
      channelId: ch.id,
      platform: ch.platform,
      displayName: ch.display_name,
      detail: ch.needs_reauth_reason ?? "Reconnect required before the access token expires.",
      expiresAt: expiresAtIso,
      daysLeft,
    });
    await db
      .update(channels)
      .set({ metadata: { ...meta, finalReauthReminderForExpiry: expiresAtIso } })
      .where(eq(channels.id, ch.id));
  }

  return { enqueued };
}
