import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import { decryptChannelToken } from "./tokens";
import { getProvider } from "@/lib/platforms/registry";
import { GRAPH_API_BASE } from "@/lib/platforms/constants";
import { diffSubscribedFields, expectedPageFields } from "@/lib/platforms/webhook-fields";

/**
 * WEBHOOKSUB1: per-channel webhook subscription health. Lets a self-hosted PRO instance SEE which
 * expected page fields are actually subscribed vs missing, and re-apply the canonical set in one click
 * — so the subscription is always correctly auto-configured, never silently partial.
 */
export interface ChannelSubscriptionStatus {
  channelId: string;
  platform: string;
  displayName: string | null;
  pageId: string | null;
  active: string[];
  missing: string[];
  ok: boolean; // every expected field is subscribed
  error?: string; // couldn't determine (token / Graph error)
}

const SUBSCRIBABLE: Platform[] = ["facebook", "instagram"];

export function isSubscribablePlatform(platform: string): boolean {
  return (SUBSCRIBABLE as string[]).includes(platform);
}

/** The underlying page id whose subscription we manage: FB = its own id; IG = the linked page id
 *  stored in the token (IG messaging is delivered through the linked Page subscription). */
function pageIdForChannel(platform: string, platformId: string, token: { page_id?: unknown }): string | null {
  if (platform === "facebook") return platformId;
  if (platform === "instagram") return typeof token.page_id === "string" ? token.page_id : null;
  return null;
}

/** GET the page's currently-subscribed fields for our app. */
async function fetchSubscribedFields(
  pageId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(`${GRAPH_API_BASE}/${pageId}/subscribed_apps?access_token=${encodeURIComponent(accessToken)}`);
  const j = (await res.json().catch(() => ({}))) as {
    data?: Array<{ subscribed_fields?: string[] }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(j.error?.message ?? `Graph ${res.status}`);
  return j.data?.[0]?.subscribed_fields ?? [];
}

/** Status for one channel (also used by the per-row "Fix" re-render). */
export async function channelSubscriptionStatus(
  ch: { id: string; platform: string; platform_id: string; display_name: string | null; token_encrypted: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelSubscriptionStatus> {
  // channelSubscriptionStatus is only ever called for subscribable (facebook/instagram) channels.
  const wfPlatform = ch.platform as "facebook" | "instagram";
  const base = { channelId: ch.id, platform: ch.platform, displayName: ch.display_name };
  const allExpected = [...expectedPageFields(wfPlatform)];
  try {
    const token = decryptChannelToken(ch.token_encrypted) as { access_token: string; page_id?: unknown };
    const pageId = pageIdForChannel(ch.platform, ch.platform_id, token);
    if (!pageId) return { ...base, pageId: null, active: [], missing: allExpected, ok: false, error: "no linked page id" };
    const current = await fetchSubscribedFields(pageId, token.access_token, fetchImpl);
    const { active, missing } = diffSubscribedFields(wfPlatform, current);
    return { ...base, pageId, active, missing, ok: missing.length === 0 };
  } catch (e) {
    return { ...base, pageId: null, active: [], missing: allExpected, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Per-channel subscription status for every subscribable channel in the workspace (panel data). */
export async function loadSubscriptionStatuses(
  workspaceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelSubscriptionStatus[]> {
  const rows = await db.query.channels.findMany({
    where: and(eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at), inArray(channels.platform, SUBSCRIBABLE)),
    columns: { id: true, platform: true, platform_id: true, display_name: true, token_encrypted: true },
  });
  return Promise.all(rows.map((ch) => channelSubscriptionStatus(ch, fetchImpl)));
}

/**
 * Re-apply the canonical subscription for one channel — the "Fix" button + the auto-config hook.
 * Resolves the page id + token and calls the provider's subscribePageWebhooks, which POSTs the full
 * expected field set (idempotent). Returns false when the channel can't be subscribed.
 */
export async function reconcileChannelSubscription(workspaceId: string, channelId: string): Promise<boolean> {
  const ch = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)),
    columns: { platform: true, platform_id: true, token_encrypted: true },
  });
  if (!ch || !isSubscribablePlatform(ch.platform)) return false;
  const provider = getProvider(ch.platform);
  if (!provider.subscribePageWebhooks) return false;
  const token = decryptChannelToken(ch.token_encrypted) as { access_token: string; page_id?: unknown };
  const pageId = pageIdForChannel(ch.platform, ch.platform_id, token);
  if (!pageId) return false;
  return provider.subscribePageWebhooks(pageId, token.access_token);
}
