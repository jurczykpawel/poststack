import type { Platform } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptTokens } from "@/lib/crypto";
import { randomBytes } from "crypto";
import type { ConnectedAccount } from "@/lib/platforms/base";

/**
 * Upsert channels from OAuth-connected accounts.
 * Creates a new Channel or updates the tokens on an existing one.
 */
export async function upsertChannels(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[]
): Promise<void> {
  for (const account of accounts) {
    const encryptedTokens = encryptTokens(account.tokens);
    const webhookSecret = randomBytes(32).toString("hex");

    await prisma.channel.upsert({
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
        webhook_secret: webhookSecret,
        is_active: true,
      },
      update: {
        display_name: account.displayName,
        username: account.username ?? null,
        profile_picture: account.profilePicture ?? null,
        token_encrypted: encryptedTokens,
        is_active: true,
      },
    });
  }
}
