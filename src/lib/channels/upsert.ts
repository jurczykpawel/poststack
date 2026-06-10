import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, platform as platformEnum, channelConnectionMode as connModeEnum } from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";
import { addJobTx } from "@/lib/queue/client";
import { randomBytes } from "crypto";
import type { ConnectedAccount } from "@/lib/platforms/base";

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
  opts: { connectionMode?: ChannelConnectionMode; deferDrain?: boolean } = {}
): Promise<{ recoveredChannelIds: string[] }> {
  const connectionMode = opts.connectionMode ?? "oauth";
  if (accounts.length > MAX_ACCOUNTS_PER_OAUTH) {
    throw new Error(`Too many accounts (${accounts.length}), max ${MAX_ACCOUNTS_PER_OAUTH}`);
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
    const out: { channelId: string; recovered: boolean }[] = [];
    for (const account of ordered) {
      const encryptedTokens = encryptTokens(account.tokens);
      const lockKey = `channel:${platform}:${account.platformId}`;

      // Serialize concurrent connects for this exact account; the lock releases on
      // commit, so the ownership check and the insert are one critical section.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      // Look at the LIVE (non-disabled) owner only. The partial unique index
      // guarantees at most one such row per account, so this is deterministic —
      // unlike matching any row, which could return a stale disabled duplicate and
      // let the upsert re-activate it into a raw unique-constraint violation.
      const live = await tx.query.channels.findFirst({
        where: and(
          eq(channels.platform, platform),
          eq(channels.platform_id, account.platformId),
          ne(channels.status, "disabled"),
        ),
        columns: { id: true, status: true, workspace_id: true },
      });
      if (live && live.workspace_id !== workspaceId) {
        throw new Error(`This ${platform} account is already connected to another workspace`);
      }

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
          },
        })
        .returning({ id: channels.id });

      const recovered = live?.status === "needs_reauth";
      out.push({ channelId: channel.id, recovered });

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

  const recoveredChannelIds = results.filter((r) => r.recovered).map((r) => r.channelId);
  return { recoveredChannelIds };
}
