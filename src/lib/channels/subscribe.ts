import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { getProvider } from "@/lib/platforms/registry";
import { decryptTokens } from "@/lib/crypto";
import { markChannelNeedsReauth } from "./health";

/** Surfaced on a channel that connected but whose inbound webhook subscription failed — it would
 *  otherwise silently receive NO events. The health sweep / re-subscribe clears it. */
export const SUBSCRIBE_FAILED_ERROR = "Webhook subscription failed — no inbound events until re-subscribed";

/**
 * Subscribe a set of just-connected channels to their inbound webhook events, and flag any that fail
 * (so a half-connected channel that receives nothing is visible, not silent). ONE path for every
 * connect route — OAuth (FB/IG) AND the managed-connection mint — so a managed-connection account is
 * a full dual-capability channel (publish + receive) on the same row, not publish-only. Meta delivers
 * IG events through the linked Page subscription, so IG channels subscribe by their `tokens.page_id`;
 * FB pages subscribe by their own id. Best-effort: a subscribe failure never throws.
 */
export async function subscribeChannelWebhooks(
  workspaceId: string,
  platform: Platform,
  accounts: ConnectedAccount[],
): Promise<{ failedPlatformIds: string[] }> {
  const provider = getProvider(platform);
  if (!provider.subscribePageWebhooks || accounts.length === 0) return { failedPlatformIds: [] };
  const subscribe = provider.subscribePageWebhooks.bind(provider);

  const results = await Promise.allSettled(
    accounts.map((a) => subscribe(String(a.tokens.page_id ?? a.platformId), a.tokens.access_token)),
  );
  const failedPlatformIds = accounts
    .filter((_, i) => results[i]!.status === "rejected" || (results[i] as PromiseFulfilledResult<boolean>).value === false)
    .map((a) => a.platformId);

  if (failedPlatformIds.length > 0) {
    await db
      .update(channels)
      .set({ last_error: SUBSCRIBE_FAILED_ERROR })
      .where(
        and(
          eq(channels.workspace_id, workspaceId),
          eq(channels.platform, platform),
          inArray(channels.platform_id, failedPlatformIds),
        ),
      );
  }
  return { failedPlatformIds };
}

/** IGFU3: needs_reauth reason stamped on an IG-Login-only channel whose per-account messaging
 *  subscription failed — its ONLY inbound path is dead, so "active" would be a lie. */
export const MESSAGING_SUBSCRIBE_FAILED_REASON = "messaging_webhook_subscribe_failed";

/**
 * IGFU2 + IGFU3: after Instagram Business Login mints the IGQW token, subscribe the IG account to
 * messaging webhooks the IG-Login-native way (per-account `subscribed_apps` on graph.instagram.com)
 * and make the channel's status tell the truth about whether it can actually receive.
 *
 * Run from the IG-Login callback for BOTH connect cases (a fresh IG-Login-only channel AND the
 * augment of an existing FB-login channel) — the IG-Login product subscription is per-account and
 * idempotent, so re-subscribing is safe.
 *
 * Status (IGFU3): on success the channel genuinely receives → keep "active". On failure, the account
 * gets no DMs. For a channel whose ONLY inbound path is this subscription (no Facebook Page token
 * behind it) that means "active" is misleading → flag it `needs_reauth` with a clear reason and fire
 * the channel-down alert (markChannelNeedsReauth). A channel that ALSO carries an FB page token still
 * receives via its Page subscription, so it is NOT downgraded by an IG-Login subscribe failure.
 *
 * Best-effort: a subscribe error never throws out of the OAuth callback.
 */
export async function subscribeInstagramMessaging(
  workspaceId: string,
  igUserId: string,
  messagingToken: string,
): Promise<{ ok: boolean }> {
  const provider = getProvider("instagram");
  if (typeof provider.subscribeMessagingWebhooks !== "function") return { ok: true };

  const ok = await provider.subscribeMessagingWebhooks(messagingToken, igUserId).catch(() => false);
  if (ok) return { ok: true };

  // Subscription failed → no inbound. Only downgrade a channel that has no other inbound path.
  const channel = await db.query.channels.findFirst({
    where: and(
      eq(channels.workspace_id, workspaceId),
      eq(channels.platform, "instagram"),
      eq(channels.platform_id, igUserId),
      ne(channels.status, "disabled"),
    ),
    columns: { id: true, token_encrypted: true },
  });
  if (channel) {
    const blob = decryptTokens(channel.token_encrypted);
    const receivesViaPage = Boolean(blob.access_token || blob.page_id);
    if (!receivesViaPage) {
      await markChannelNeedsReauth(channel.id, MESSAGING_SUBSCRIBE_FAILED_REASON);
    }
  }
  return { ok: false };
}
