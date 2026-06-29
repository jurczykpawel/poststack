/**
 * Instagram Business Login (IGML5) — direct OAuth on `instagram.com` / `api.instagram.com` /
 * `graph.instagram.com`, separate from the Facebook-Login-derived Instagram flow in `instagram.ts`.
 *
 * Why a second login: at Standard Access (no App Review — the self-host promise) a Facebook-Login
 * token cannot receive/reply to IG DMs. Instagram Business Login mints an IGQW user token that CAN,
 * via `graph.instagram.com`. We store that token as the channel's `messaging_token`; the provider's
 * messaging surface already routes to `graph.instagram.com` when it's present (see instagram.ts).
 *
 * The version literal lives ONLY in constants.ts (IG_GRAPH_BASE) — never hardcode
 * `graph.instagram.com/vNN` here (guarded by version-source.test.ts). The long-lived exchange uses
 * the *unversioned* host (`graph.instagram.com/access_token`), derived from IG_GRAPH_BASE's origin.
 */
import { getConfig } from "@/lib/settings/config";
import { IG_OAUTH_BASE, IG_OAUTH_TOKEN_BASE, IG_GRAPH_BASE } from "./constants";

/** Scopes for IG-Login at Standard Access: messaging + comments (+ basic profile). */
export const IG_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export interface InstagramLoginResult {
  /** The Instagram professional account id — this is the channel's `platform_id`. */
  igUserId: string;
  username?: string;
  /** Long-lived IGQW token (60 days) — stored as the channel's `messaging_token`. */
  messagingToken: string;
  /** Token expiry, or null if the provider returned no `expires_in`. */
  expiresAt: Date | null;
}

/** Build the Instagram Business Login authorize URL. */
export async function buildInstagramLoginAuthUrl(state: string, redirectUri: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: await getConfig("INSTAGRAM_APP_ID"),
    redirect_uri: redirectUri,
    scope: IG_LOGIN_SCOPES.join(","),
    response_type: "code",
    state,
  });
  return `${IG_OAUTH_BASE}/oauth/authorize?${params.toString()}`;
}

/**
 * Newer Instagram-Login responses wrap the payload in `{ data: [ ... ] }`; older ones return it flat.
 * Normalise to the inner object so callers read fields the same way regardless of shape.
 */
function unwrap(json: unknown): Record<string, unknown> {
  if (json && typeof json === "object") {
    const data = (json as { data?: unknown }).data;
    if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? {};
    return json as Record<string, unknown>;
  }
  return {};
}

/**
 * Exchange an authorization code for the long-lived IG-Login messaging token + the IG business id.
 *
 *  1. POST api.instagram.com/oauth/access_token (form) → short-lived `{ access_token, user_id }`.
 *  2. GET  graph.instagram.com/access_token?grant_type=ig_exchange_token → long-lived (60-day) token.
 *  3. GET  {IG_GRAPH_BASE}/me?fields=user_id,username → the IG professional account id + handle.
 */
export async function exchangeInstagramLoginCode(code: string, redirectUri: string): Promise<InstagramLoginResult> {
  // 1. short-lived token (form-encoded POST)
  const form = new URLSearchParams({
    client_id: await getConfig("INSTAGRAM_APP_ID"),
    client_secret: await getConfig("INSTAGRAM_APP_SECRET"),
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  const shortRes = await fetch(`${IG_OAUTH_TOKEN_BASE}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!shortRes.ok) {
    throw new Error(`Instagram-Login token exchange failed: ${await shortRes.text()}`);
  }
  const short = unwrap(await shortRes.json());
  const shortToken = typeof short.access_token === "string" ? short.access_token : "";
  if (!shortToken) throw new Error("Instagram-Login short-lived token missing access_token");

  // 2. long-lived token — unversioned host (graph.instagram.com/access_token)
  // SECURITY: the `client_secret` sits in the query string because Meta's `ig_exchange_token` API
  // mandates a GET with the secret as a query param (unavoidable — there is no POST/header form).
  // Consequence: outbound-request URL logging must NEVER be enabled around this call, or the secret
  // would leak into logs (secrets-in-URL). Keep any fetch tracing here body/header-only.
  const graphHost = new URL(IG_GRAPH_BASE).origin;
  const llParams = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: await getConfig("INSTAGRAM_APP_SECRET"),
    access_token: shortToken,
  });
  const llRes = await fetch(`${graphHost}/access_token?${llParams.toString()}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!llRes.ok) {
    throw new Error(`Instagram-Login long-lived exchange failed: ${await llRes.text()}`);
  }
  const ll = (await llRes.json()) as { access_token?: string; expires_in?: number };
  const messagingToken = typeof ll.access_token === "string" ? ll.access_token : "";
  if (!messagingToken) throw new Error("Instagram-Login long-lived token missing access_token");
  const expiresAt =
    typeof ll.expires_in === "number" && ll.expires_in > 0 ? new Date(Date.now() + ll.expires_in * 1000) : null;

  // 3. resolve the IG professional account id (= channel platform_id) + handle
  const meRes = await fetch(
    `${IG_GRAPH_BASE}/me?` + new URLSearchParams({ fields: "user_id,username", access_token: messagingToken }),
    { redirect: "error", signal: AbortSignal.timeout(10_000) },
  );
  if (!meRes.ok) {
    throw new Error(`Instagram-Login /me lookup failed: ${await meRes.text()}`);
  }
  const me = unwrap(await meRes.json());
  const igUserId =
    me.user_id != null ? String(me.user_id) : short.user_id != null ? String(short.user_id) : "";
  if (!igUserId) throw new Error("Instagram-Login: could not resolve the Instagram business account id");

  return {
    igUserId,
    username: typeof me.username === "string" ? me.username : undefined,
    messagingToken,
    expiresAt,
  };
}
