import type { Platform } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { encryptTokens } from "@/lib/crypto";
import { addJob } from "@/lib/queue/client";
import { randomBytes } from "crypto";
import type { ConnectedAccount } from "@/lib/platforms/base";

const MAX_ACCOUNTS_PER_OAUTH = 50;

/**
 * Upsert channels from OAuth-connected accounts.
 * Creates a new Channel or updates the tokens on an existing one.
 * Webhook secret is only generated on first creation — not rotated on reconnect.
 */
export async function upsertChannels(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[]
): Promise<void> {
  if (accounts.length > MAX_ACCOUNTS_PER_OAUTH) {
    throw new Error(`Too many accounts (${accounts.length}), max ${MAX_ACCOUNTS_PER_OAUTH}`);
  }

  for (const account of accounts) {
    const encryptedTokens = encryptTokens(account.tokens);

    // Was this channel previously broken? If so, reconnecting recovers it and
    // we drain any outbound parked while it was down (REL5).
    const existing = await prisma.channel.findUnique({
      where: {
        workspace_id_platform_id: { workspace_id: workspaceId, platform_id: account.platformId },
      },
      select: { id: true, status: true },
    });

    const channel = await prisma.channel.upsert({
      where: {
        workspace_id_platform_id: {
          workspace_id: workspaceId,
          platform_id: account.platformId,
        },
      },
      create: {
        workspace_id: workspaceId,
        platform,
        platform_id: account.platformId,
        display_name: account.displayName,
        username: account.username ?? null,
        profile_picture: account.profilePicture ?? null,
        token_encrypted: encryptedTokens,
        webhook_secret: randomBytes(32).toString("hex"),
        status: "active",
      },
      update: {
        display_name: account.displayName,
        username: account.username ?? null,
        profile_picture: account.profilePicture ?? null,
        token_encrypted: encryptedTokens,
        status: "active",
        last_error: null,
      },
    });

    if (existing?.status === "needs_reauth") {
      await addJob("drain-channel", { channelId: channel.id });
    }
  }
}
