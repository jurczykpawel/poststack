import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, platform as platformEnum, channelConnectionMode as connModeEnum } from "@/db/schema";
import { encryptTokens, decryptTokens } from "@/lib/crypto";
import { addJobTx } from "@/lib/queue/client";
import { randomBytes } from "crypto";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { hasFeature, ProRequiredError } from "@/lib/license/gate";
import { emitEventNow } from "@/lib/events";

const META_PLATFORMS = new Set<Platform>(["facebook", "instagram"]);

/**
 * Free-tier channel limits: one Facebook + one Instagram channel, nothing else.
 * A 2nd+ channel of the same Meta platform needs `multi_channel`; any non-Meta
 * channel needs `non_meta_channels`. Reconnecting an already-connected account
 * (same platform_id) is never gated. Throws ProRequiredError (→ 402) when the
 * instance isn't licensed for the needed feature.
 */
export async function assertChannelsAllowed(workspaceId: string, platform: Platform, accounts: ConnectedAccount[]): Promise<void> {
  const existing = await db.query.channels.findMany({
    where: and(eq(channels.workspace_id, workspaceId), eq(channels.platform, platform), ne(channels.status, "disabled")),
    columns: { platform_id: true },
  });
  const existingIds = new Set(existing.map((c) => c.platform_id));
  const newIds = accounts.map((a) => a.platformId).filter((id) => !existingIds.has(id));
  if (newIds.length === 0) return; // pure reconnect / token refresh

  if (!META_PLATFORMS.has(platform)) {
    if (!(await hasFeature("non_meta_channels"))) throw new ProRequiredError("non_meta_channels");
    return;
  }
  if (existingIds.size + newIds.length > 1 && !(await hasFeature("multi_channel"))) {
    throw new ProRequiredError("multi_channel");
  }
}

type Platform = (typeof platformEnum.enumValues)[number];
type ChannelConnectionMode = (typeof connModeEnum.enumValues)[number];

const MAX_ACCOUNTS_PER_OAUTH = 50;

/**
 * Upsert channels from connected accounts (OAuth or a pasted manual token).
 * Creates a new Channel or updates the tokens on an existing one.
 * Webhook secret is only generated on first creation — not rotated on reconnect.
 *
 * An account (platform, platform_id) belongs to exactly one workspace. That
 * ownership is claimed atomically under a transaction-scoped advisory lock, so
 * two concurrent connects of the same page/bot cannot each create a row in a
 * different workspace (which would make webhook routing ambiguous).
 *
 * INVARIANT: this is the *only* path that inserts a channel. The "one account,
 * one workspace" guarantee that incoming-event routing relies on (workers resolve
 * a channel by (platform, platform_id)) is enforced here in the application layer,
 * not by a global DB constraint. The DB unique index is intentionally per-workspace
 * (workspace_id, platform, platform_id) — a superset of the old key — so the
 * uniqueness migration can never fail on data the previous schema allowed; a global
 * (platform, platform_id) index would be migration-breaking. If a new code path ever
 * needs to create a channel, it MUST go through this function (or replicate the lock +
 * cross-workspace ownership check) so the routing invariant holds.
 */
export async function upsertChannels(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[],
  opts: {
    connectionMode?: ChannelConnectionMode;
    deferDrain?: boolean;
    /** Link these channels to a managed connection (account_sources.id). Stamped on derived channels. */
    sourceId?: string | null;
    /** The ~90-day data-access wall inherited from the source (for the badge + expiry cron). */
    dataAccessExpiresAt?: Date | null;
    /**
     * IGML5: Instagram Business Login. Instead of writing `account.tokens`, ADD the IG-Login IGQW
     * `messaging_token` (+ its expiry) to the EXISTING channel's encrypted blob — preserving the FB
     * page token (`access_token`/`user_access_token`/`page_id`) so publishing/comments keep working.
     * If no live channel exists for the account, a minimal IG-Login-only channel is created.
     */
    augmentMessagingToken?: { token: string; expiresAt: Date };
  } = {}
): Promise<{ recoveredChannelIds: string[] }> {
  const connectionMode = opts.connectionMode ?? "oauth";
  const sourceId = opts.sourceId ?? null;
  const dataAccessExpiresAt = opts.dataAccessExpiresAt ?? null;
  if (accounts.length > MAX_ACCOUNTS_PER_OAUTH) {
    throw new Error(`Too many accounts (${accounts.length}), max ${MAX_ACCOUNTS_PER_OAUTH}`);
  }

  if (opts.augmentMessagingToken) {
    return augmentMessagingTokens(workspaceId, platform, accounts, opts.augmentMessagingToken, connectionMode);
  }

  // Acquire the per-account advisory locks in a stable order so two concurrent
  // multi-account connects can't deadlock taking them in different orders.
  const ordered = [...accounts].sort((a, b) =>
    a.platformId < b.platformId ? -1 : a.platformId > b.platformId ? 1 : 0,
  );

  // One transaction for every account: either all channels are written or none is,
  // so a later account's rejection rolls back the earlier ones instead of leaving
  // them half-connected.
  const results = await db.transaction(async (tx) => {
    const out: { channelId: string; recovered: boolean; isNew: boolean; displayName: string }[] = [];
    for (const account of ordered) {
      const lockKey = `channel:${platform}:${account.platformId}`;
      // Plaintext token-death clock for the badge + proactive expiry cron (no decrypt needed).
      // Page/System-User tokens carry no expires_at → NULL (permanent).
      const tokenExpiresAt =
        typeof account.tokens.expires_at === "number" && account.tokens.expires_at > 0
          ? new Date(account.tokens.expires_at * 1000)
          : null;

      // Serialize concurrent connects for this exact account; the lock releases on
      // commit, so the ownership check and the insert are one critical section.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      // Look at the LIVE (non-disabled) owner only. The partial unique index
      // guarantees at most one such row per account, so this is deterministic —
      // unlike matching any row, which could return a stale disabled duplicate and
      // let the upsert re-activate it into a raw unique-constraint violation.
      // token_encrypted is read so an IG-Login messaging_token attached earlier can be
      // carried forward (below) instead of being clobbered by this FB-side write.
      const live = await tx.query.channels.findFirst({
        where: and(
          eq(channels.platform, platform),
          eq(channels.platform_id, account.platformId),
          ne(channels.status, "disabled"),
        ),
        columns: { id: true, status: true, workspace_id: true, token_encrypted: true },
      });
      if (live && live.workspace_id !== workspaceId) {
        throw new Error(`This ${platform} account is already connected to another workspace`);
      }

      // IGML5 invariant preservation: this FB-side blob carries NO messaging_token. If the live
      // Instagram channel was previously augmented with an IG-Login messaging_token, merge that
      // token (+ its in-blob expiry) FORWARD — never let an FB-only write drop it (which would
      // break "column non-null ⟺ blob has messaging_token", lie in the badge, and silently kill IG
      // DMs with no needs_reauth). Mirrors mergeFbTokenFields in token-refresh-worker.ts.
      // New channel / non-instagram / no live messaging_token → unchanged (column stays NULL).
      const tokens = { ...account.tokens };
      let messagingTokenExpiresAt: Date | null = null;
      if (live && platform === "instagram") {
        try {
          const liveBlob = decryptTokens(live.token_encrypted);
          if (liveBlob.messaging_token) {
            tokens.messaging_token = liveBlob.messaging_token;
            if (liveBlob.messaging_token_expires_at != null) {
              tokens.messaging_token_expires_at = liveBlob.messaging_token_expires_at;
              const unix = Number(liveBlob.messaging_token_expires_at);
              messagingTokenExpiresAt = Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000) : null;
            }
          }
        } catch {
          // Unreadable live blob (shouldn't happen) → write the FB-only tokens rather than fail.
        }
      }
      const encryptedTokens = encryptTokens(tokens);

      const [channel] = await tx
        .insert(channels)
        .values({
          workspace_id: workspaceId,
          platform,
          platform_id: account.platformId,
          display_name: account.displayName,
          username: account.username ?? null,
          profile_picture: account.profilePicture ?? null,
          token_encrypted: encryptedTokens,
          webhook_secret: randomBytes(32).toString("hex"),
          status: "active",
          connection_mode: connectionMode,
          source_id: sourceId,
          token_expires_at: tokenExpiresAt,
          data_access_expires_at: dataAccessExpiresAt,
          messaging_token_expires_at: messagingTokenExpiresAt,
        })
        .onConflictDoUpdate({
          target: [channels.workspace_id, channels.platform, channels.platform_id],
          set: {
            display_name: account.displayName,
            username: account.username ?? null,
            profile_picture: account.profilePicture ?? null,
            token_encrypted: encryptedTokens,
            status: "active",
            last_error: null,
            connection_mode: connectionMode,
            source_id: sourceId,
            token_expires_at: tokenExpiresAt,
            data_access_expires_at: dataAccessExpiresAt,
            messaging_token_expires_at: messagingTokenExpiresAt,
          },
        })
        .returning({ id: channels.id });

      const recovered = live?.status === "needs_reauth";
      out.push({ channelId: channel.id, recovered, isNew: !live, displayName: account.displayName });

      // Reconnecting a broken channel recovers it — drain anything parked while it was down
      //. Enqueue the drain in the SAME transaction as the recovery (a transactional
      // outbox), so a failed enqueue rolls the recovery back and the next reconnect re-drains
      // instead of stranding held messages behind an already-active channel. Callers
      // that must confirm the channel works first (e.g. Telegram waits for setWebhook) pass
      // deferDrain and enqueue the drain themselves once confirmed.
      if (recovered && !opts.deferDrain) {
        await addJobTx(tx, "drain-channel", { channelId: channel.id }, { jobKey: `drain-channel:${channel.id}` });
      }
    }
    return out;
  });

  // Log a connect/reconnect event per channel for the activity feed (/events). Best-effort and
  // post-commit: a logging failure must never roll back a successful connect.
  for (const r of results) {
    await emitEventNow(
      workspaceId,
      r.isNew ? "channel.created" : "channel.reconnected",
      { type: "channel", id: r.channelId },
      { platform, displayName: r.displayName },
    ).catch(() => {});
  }

  const recoveredChannelIds = results.filter((r) => r.recovered).map((r) => r.channelId);
  return { recoveredChannelIds };
}

/**
 * IGML5: attach an Instagram Business Login IGQW `messaging_token` to a channel. For an EXISTING live
 * channel (same account) the blob is decrypted, the messaging token (+ expiry) merged in, and
 * re-encrypted — the FB page token and every other field are preserved. For an account with no live
 * channel, a minimal IG-Login-only channel is created (no FB page token; publishing/comments will
 * need a Facebook Login later). Reuses the same advisory-lock + cross-workspace ownership invariant
 * as the main upsert path so routing stays unambiguous.
 */
async function augmentMessagingTokens(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[],
  augment: { token: string; expiresAt: Date },
  connectionMode: ChannelConnectionMode,
): Promise<{ recoveredChannelIds: string[] }> {
  const expiresAtUnix = Math.floor(augment.expiresAt.getTime() / 1000);

  const ordered = [...accounts].sort((a, b) =>
    a.platformId < b.platformId ? -1 : a.platformId > b.platformId ? 1 : 0,
  );

  const results = await db.transaction(async (tx) => {
    const out: { channelId: string; recovered: boolean; isNew: boolean; displayName: string }[] = [];
    for (const account of ordered) {
      const lockKey = `channel:${platform}:${account.platformId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const live = await tx.query.channels.findFirst({
        where: and(
          eq(channels.platform, platform),
          eq(channels.platform_id, account.platformId),
          ne(channels.status, "disabled"),
        ),
        columns: { id: true, status: true, workspace_id: true, token_encrypted: true },
      });
      if (live && live.workspace_id !== workspaceId) {
        throw new Error(`This ${platform} account is already connected to another workspace`);
      }

      if (live) {
        // Merge the messaging token INTO the existing blob — never clobber the FB page token.
        const blob = decryptTokens(live.token_encrypted);
        blob.messaging_token = augment.token;
        blob.messaging_token_expires_at = expiresAtUnix;

        await tx
          .update(channels)
          .set({
            token_encrypted: encryptTokens(blob),
            messaging_token_expires_at: augment.expiresAt,
            status: "active",
            last_error: null,
          })
          .where(eq(channels.id, live.id));

        const recovered = live.status === "needs_reauth";
        out.push({ channelId: live.id, recovered, isNew: false, displayName: account.displayName });
        if (recovered) {
          await addJobTx(tx, "drain-channel", { channelId: live.id }, { jobKey: `drain-channel:${live.id}` });
        }
        continue;
      }

      // No LIVE channel for this account yet → minimal IG-Login-only channel (messaging token only).
      // A6: a DISABLED row may already exist for this exact (workspace, platform, platform_id) — the
      // `live` lookup excludes disabled, but the unique index covers it, so a raw insert would 500
      // (→ oauth_failed). Mirror the main path: onConflictDoUpdate the unique target to revive it
      // (active, attach the messaging token + expiry column, clear last_error) instead of crashing.
      const tokens: Record<string, unknown> = { access_token: "", messaging_token: augment.token };
      tokens.messaging_token_expires_at = expiresAtUnix;
      const encryptedTokens = encryptTokens(tokens as ConnectedAccount["tokens"]);
      const [channel] = await tx
        .insert(channels)
        .values({
          workspace_id: workspaceId,
          platform,
          platform_id: account.platformId,
          display_name: account.displayName,
          username: account.username ?? null,
          profile_picture: account.profilePicture ?? null,
          token_encrypted: encryptedTokens,
          webhook_secret: randomBytes(32).toString("hex"),
          status: "active",
          connection_mode: connectionMode,
          messaging_token_expires_at: augment.expiresAt,
        })
        .onConflictDoUpdate({
          target: [channels.workspace_id, channels.platform, channels.platform_id],
          set: {
            display_name: account.displayName,
            username: account.username ?? null,
            profile_picture: account.profilePicture ?? null,
            token_encrypted: encryptedTokens,
            messaging_token_expires_at: augment.expiresAt,
            status: "active",
            last_error: null,
            connection_mode: connectionMode,
          },
        })
        .returning({ id: channels.id });
      out.push({ channelId: channel.id, recovered: false, isNew: true, displayName: account.displayName });
    }
    return out;
  });

  for (const r of results) {
    await emitEventNow(
      workspaceId,
      r.isNew ? "channel.created" : "channel.reconnected",
      { type: "channel", id: r.channelId },
      { platform, displayName: r.displayName },
    ).catch(() => {});
  }

  const recoveredChannelIds = results.filter((r) => r.recovered).map((r) => r.channelId);
  return { recoveredChannelIds };
}
