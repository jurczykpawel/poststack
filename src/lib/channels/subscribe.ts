import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import type { ConnectedAccount } from "@/lib/platforms/base";
import { getProvider } from "@/lib/platforms/registry";

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
