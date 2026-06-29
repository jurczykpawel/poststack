import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, type Platform } from "@/db/schema";
import { decryptChannelToken } from "./tokens";
import {
  subscribeInstagramMessaging,
  SUBSCRIBE_FAILED_ERROR,
  MESSAGING_SUBSCRIBE_FAILED_REASON,
  MESSAGING_SUBSCRIBE_FAILED_FB_WARNING,
} from "./subscribe";
import { markChannelHealthy } from "./health";
import { getProvider } from "@/lib/platforms/registry";
import { GRAPH_API_BASE, IG_GRAPH_BASE } from "@/lib/platforms/constants";
import { diffFields, diffSubscribedFields, expectedPageFields, instagramLoginFields } from "@/lib/platforms/webhook-fields";

/**
 * WEBHOOKSUB1: per-channel webhook subscription health. Lets a self-hosted PRO instance SEE which
 * expected page fields are actually subscribed vs missing, and re-apply the canonical set in one click
 * — so the subscription is always correctly auto-configured, never silently partial.
 */
export interface ChannelSubscriptionStatus {
  channelId: string;
  platform: string;
  displayName: string | null;
  // Which subscription model this row reflects: a Facebook Page `subscribed_apps` ("page") or an
  // IG-Login per-account `subscribed_apps` on graph.instagram.com ("instagram_login"). Display
  // discriminator — the IG-Login row has no linked Page id.
  kind: "page" | "instagram_login";
  pageId: string | null;
  active: string[];
  missing: string[];
  ok: boolean; // every expected field is subscribed
  error?: string; // couldn't determine (token / Graph error)
  // SUBDUAL1: a DUAL channel (Facebook Page token AND an IG-Login `messaging_token`) has its DMs ride
  // the per-account IG-Login subscription, which the page row (`kind:"page"`) above does NOT reflect.
  // When present, this is that per-account `instagram`-object subscription on graph.instagram.com,
  // surfaced alongside the page status so a dual channel can't read "fully subscribed" on the page
  // while its IG-Login sub is unverified. Absent for FB-only and IG-Login-only channels.
  igLogin?: { active: string[]; missing: string[]; ok: boolean; error?: string };
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

/** GET an IG-Login account's per-account subscribed fields (the `instagram` object subscription on
 *  graph.instagram.com). Mirrors {@link fetchSubscribedFields} but on the IG host with the IG-Login
 *  messaging token. SECURITY: the token rides the URL query (Meta accepts it only there on this host) —
 *  never log this URL. Version literal stays in constants.ts (IG_GRAPH_BASE), never inlined. */
async function fetchIgLoginSubscribedFields(
  igUserId: string,
  messagingToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const res = await fetchImpl(
    `${IG_GRAPH_BASE}/${encodeURIComponent(igUserId)}/subscribed_apps?access_token=${encodeURIComponent(messagingToken)}`,
  );
  const j = (await res.json().catch(() => ({}))) as {
    data?: Array<{ subscribed_fields?: string[] }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(j.error?.message ?? `Graph ${res.status}`);
  return j.data?.[0]?.subscribed_fields ?? [];
}

/** SUBDUAL1: compute a DUAL channel's IG-Login per-account sub-result (active/missing vs
 *  instagramLoginFields). Never throws — a Graph/token error becomes a sub-result with all fields
 *  missing + the error message, so it can't break the page status it's attached to. */
async function igLoginSubResult(
  igUserId: string,
  messagingToken: string,
  fetchImpl: typeof fetch,
): Promise<{ active: string[]; missing: string[]; ok: boolean; error?: string }> {
  try {
    const current = await fetchIgLoginSubscribedFields(igUserId, messagingToken, fetchImpl);
    const { active, missing } = diffFields(instagramLoginFields(), current);
    return { active, missing, ok: missing.length === 0 };
  } catch (e) {
    return { active: [], missing: [...instagramLoginFields()], ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Status for one channel (also used by the per-row "Fix" re-render). */
export async function channelSubscriptionStatus(
  ch: { id: string; platform: string; platform_id: string; display_name: string | null; token_encrypted: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelSubscriptionStatus> {
  // channelSubscriptionStatus is only ever called for subscribable (facebook/instagram) channels.
  const wfPlatform = ch.platform as "facebook" | "instagram";
  const base = { channelId: ch.id, platform: ch.platform, displayName: ch.display_name };
  try {
    const token = decryptChannelToken(ch.token_encrypted) as { access_token?: string; page_id?: unknown; messaging_token?: unknown };
    // IG-Login-only channel: an Instagram Business Login token with no linked Facebook Page. Its inbound
    // path is the per-account `instagram` object subscription on graph.instagram.com, NOT a Page sub.
    if (ch.platform === "instagram" && typeof token.messaging_token === "string" && !token.page_id) {
      const igExpected = [...instagramLoginFields()];
      try {
        const current = await fetchIgLoginSubscribedFields(ch.platform_id, token.messaging_token, fetchImpl);
        const { active, missing } = diffFields(instagramLoginFields(), current);
        return { ...base, kind: "instagram_login", pageId: null, active, missing, ok: missing.length === 0 };
      } catch (e) {
        return { ...base, kind: "instagram_login", pageId: null, active: [], missing: igExpected, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const allExpected = [...expectedPageFields(wfPlatform)];
    const pageId = pageIdForChannel(ch.platform, ch.platform_id, token as { page_id?: unknown });
    if (!pageId) return { ...base, kind: "page", pageId: null, active: [], missing: allExpected, ok: false, error: "no linked page id" };
    const current = await fetchSubscribedFields(pageId, token.access_token ?? "", fetchImpl);
    const { active, missing } = diffSubscribedFields(wfPlatform, current);
    // SUBDUAL1: a DUAL channel ALSO carries an IG-Login messaging_token whose per-account subscription
    // is what actually delivers its IG DMs — surface it alongside the page status. Best-effort: an error
    // computing it never breaks (nor throws out past) the page status above.
    const igLogin = typeof token.messaging_token === "string"
      ? await igLoginSubResult(ch.platform_id, token.messaging_token, fetchImpl)
      : undefined;
    // A9: a DUAL channel's IG DMs ride the per-account igLogin subscription, so the top-level `ok`
    // must FOLD igLogin — a complete page set with a missing igLogin set is NOT "fully subscribed".
    return {
      ...base,
      kind: "page",
      pageId,
      active,
      missing,
      ok: missing.length === 0 && (igLogin ? igLogin.ok : true),
      ...(igLogin ? { igLogin } : {}),
    };
  } catch (e) {
    return { ...base, kind: "page", pageId: null, active: [], missing: [...expectedPageFields(wfPlatform)], ok: false, error: e instanceof Error ? e.message : String(e) };
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
 * For PAGE channels: resolves the page id + token and calls the provider's subscribePageWebhooks,
 * which POSTs the full expected field set (idempotent). For IG-Login-only channels (a messaging_token
 * and no page_id): reconciles via subscribeInstagramMessaging instead, which re-subscribes the
 * per-account `instagram` object subscription on graph.instagram.com. Returns false when the channel
 * can't be subscribed.
 */
export async function reconcileChannelSubscription(workspaceId: string, channelId: string): Promise<boolean> {
  const ch = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId), isNull(channels.deleted_at)),
    // A4: status/last_error/needs_reauth_reason are read to decide whether a SUCCESSFUL re-apply may
    // close a breaker that a FAILED subscription opened (without ever clearing a token-death reauth).
    columns: { platform: true, platform_id: true, token_encrypted: true, status: true, last_error: true, needs_reauth_reason: true },
  });
  if (!ch || !isSubscribablePlatform(ch.platform)) return false;
  const ok = await applySubscription(workspaceId, ch.platform, ch.platform_id, ch.token_encrypted);
  // A4: on OVERALL success, if the channel's current breaker was caused by a FAILED subscription
  // (this Fix's own failure mode), close it — a re-subscribe just made the channel truthful again.
  // GATED so an unrelated token-death needs_reauth is never silently cleared by a Fix click.
  if (ok && isSubscriptionCausedFailure(ch)) {
    await markChannelHealthy(channelId);
  }
  return ok;
}

/** Apply the canonical subscription for one channel (IG-Login-only, dual, or page). Both
 *  subscribeInstagramMessaging calls run as MANUAL re-applies (A8): a transient failure here must
 *  not degrade/alert a healthy channel — the breaker is only closed (A4) on overall success. */
async function applySubscription(
  workspaceId: string,
  platform: Platform,
  platformId: string,
  tokenEncrypted: string,
): Promise<boolean> {
  const token = decryptChannelToken(tokenEncrypted) as { access_token?: string; page_id?: unknown; messaging_token?: unknown };
  // IG-Login-only channel: re-subscribe the per-account `instagram` object subscription (E2). Reuses
  // subscribeInstagramMessaging — it re-subscribes AND keeps the channel status truthful, exactly what
  // a "Fix" should do. (No circular import: subscribe.ts doesn't import subscription-status.ts.)
  if (platform === "instagram" && typeof token.messaging_token === "string" && !token.page_id) {
    const { ok } = await subscribeInstagramMessaging(workspaceId, platformId, token.messaging_token, { manual: true });
    return ok;
  }
  const provider = getProvider(platform);
  if (!provider.subscribePageWebhooks) return false;
  const pageId = pageIdForChannel(platform, platformId, token as { page_id?: unknown });
  if (!pageId) return false;
  const pageOk = await provider.subscribePageWebhooks(pageId, token.access_token ?? "");
  // SUBDUAL1: a DUAL channel (page_id AND messaging_token) receives its IG DMs via the per-account
  // IG-Login subscription too — re-apply BOTH. Succeed only if both succeed.
  if (typeof token.messaging_token === "string") {
    const { ok: igOk } = await subscribeInstagramMessaging(workspaceId, platformId, token.messaging_token, { manual: true });
    return pageOk && igOk;
  }
  return pageOk;
}

/** A4 gate: was the channel's CURRENT breaker caused by a failed subscription (so a successful
 *  re-apply may close it)? Only true when there IS a breaker (status not active OR a last_error set)
 *  AND its marker is a subscription-failure marker — never a token-death needs_reauth. */
function isSubscriptionCausedFailure(ch: {
  status: string;
  last_error: string | null;
  needs_reauth_reason: string | null;
}): boolean {
  const hasBreaker = ch.status !== "active" || ch.last_error != null;
  if (!hasBreaker) return false;
  if (ch.needs_reauth_reason === MESSAGING_SUBSCRIBE_FAILED_REASON) return true;
  const subscriptionMarkers = [SUBSCRIBE_FAILED_ERROR, MESSAGING_SUBSCRIBE_FAILED_REASON, MESSAGING_SUBSCRIBE_FAILED_FB_WARNING];
  return ch.last_error != null && subscriptionMarkers.includes(ch.last_error);
}
