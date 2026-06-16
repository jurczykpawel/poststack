import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { contacts, contactChannels } from "@/db/schema";
import type { Platform } from "@/db/schema";
import { decryptChannelToken } from "@/lib/channels/tokens";
import { getProvider } from "@/lib/platforms/registry";

/**
 * Fill a contact's name + avatar from the platform's user-profile API. Meta DM webhooks carry only
 * the sender's PSID/IGSID — no name — so without this the inbox shows the raw id. Best-effort:
 *
 *  - never throws (a profile lookup must never break message processing — caller can fire it freely);
 *  - only writes columns that are still empty, so it never clobbers a name the operator edited or a
 *    value resolved earlier;
 *  - a no-op for platforms without `getUserProfile` (e.g. Telegram, whose inbound carries the name).
 */
export async function resolveContactProfile(
  channel: { id: string; platform: Platform; token_encrypted: string },
  contactId: string,
  senderId: string,
): Promise<void> {
  try {
    const provider = getProvider(channel.platform);
    if (!provider.getUserProfile) return;

    const profile = await provider.getUserProfile(decryptChannelToken(channel.token_encrypted), senderId);
    if (!profile) return;

    if (profile.name) {
      await db
        .update(contacts)
        .set({ display_name: profile.name })
        .where(and(eq(contacts.id, contactId), isNull(contacts.display_name)));
    }
    if (profile.profilePicture) {
      await db
        .update(contacts)
        .set({ avatar_url: profile.profilePicture })
        .where(and(eq(contacts.id, contactId), isNull(contacts.avatar_url)));
    }
    if (profile.username) {
      await db
        .update(contactChannels)
        .set({ platform_username: profile.username })
        .where(
          and(
            eq(contactChannels.channel_id, channel.id),
            eq(contactChannels.platform_sender_id, senderId),
            isNull(contactChannels.platform_username),
          ),
        );
    }
  } catch {
    // best-effort: swallow — the inbox just keeps showing the id until the next attempt
  }
}
