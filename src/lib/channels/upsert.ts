import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, platform as platformEnum, channelConnectionMode as connModeEnum } from "@/db/schema";
import { encryptTokens } from "@/lib/crypto";
import { addJob } from "@/lib/queue/client";
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
 */
export async function upsertChannels(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[],
  opts: { connectionMode?: ChannelConnectionMode } = {}
): Promise<void> {
  const connectionMode = opts.connectionMode ?? "oauth";
  if (accounts.length > MAX_ACCOUNTS_PER_OAUTH) {
    throw new Error(`Too many accounts (${accounts.length}), max ${MAX_ACCOUNTS_PER_OAUTH}`);
  }

  for (const account of accounts) {
    const encryptedTokens = encryptTokens(account.tokens);
    const lockKey = `channel:${platform}:${account.platformId}`;

    const result = await db.transaction(async (tx) => {
      // Serialize concurrent connects for this exact account; the lock releases
      // on commit, so the ownership check and the insert below are atomic.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const existing = await tx.query.channels.findFirst({
        where: and(eq(channels.platform, platform), eq(channels.platform_id, account.platformId)),
        columns: { id: true, status: true, workspace_id: true },
      });
      if (existing && existing.workspace_id !== workspaceId) {
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

      // Reconnecting a broken channel recovers it — drain anything parked while
      // it was down (REL5). Enqueue after commit so a rollback can't leave a job.
      return { channelId: channel.id, recovered: existing?.status === "needs_reauth" };
    });

    if (result.recovered) {
      await addJob("drain-channel", { channelId: result.channelId });
    }
  }
}
