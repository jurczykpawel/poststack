import { and, eq } from "drizzle-orm";
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

    // Was this channel previously broken? If so, reconnecting recovers it and
    // we drain any outbound parked while it was down (REL5). Channels are
    // globally unique per (platform, platform_id).
    const existing = await db.query.channels.findFirst({
      where: and(eq(channels.platform, platform), eq(channels.platform_id, account.platformId)),
      columns: { id: true, status: true },
    });

    const [channel] = await db
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
        target: [channels.platform, channels.platform_id],
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

    if (existing?.status === "needs_reauth") {
      await addJob("drain-channel", { channelId: channel.id });
    }
  }
}
