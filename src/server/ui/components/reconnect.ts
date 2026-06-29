/** Where a "Reconnect" affordance should send the user for a channel that needs re-auth.
 *  Shared by the channels table/detail and the dashboard "Needs attention" widget so every
 *  Reconnect link lands on the right flow instead of a generic page. */

export function oauthStartHref(platform: string): string | null {
  if (platform === "facebook") return "/api/oauth/facebook";
  if (platform === "instagram") return "/api/oauth/instagram";
  if (platform === "youtube") return "/api/oauth/youtube";
  if (platform === "gmail") return "/api/oauth/gmail";
  return null;
}

export interface ReconnectTarget {
  id: string;
  platform: string;
  connection_mode: "oauth" | "manual_token" | "derived";
  messaging_connection?: "instagram_login" | "facebook_only" | null;
}

export function reconnectHref(ch: ReconnectTarget): string {
  if (ch.connection_mode === "derived") return "/sources"; // re-auth the master token
  // An IG-Login channel must re-mint its IGQW messaging token through the IG-Login flow —
  // the Facebook-login IG flow (/api/oauth/instagram) can't restore an IG-Login token.
  if (ch.connection_mode === "oauth" && ch.platform === "instagram" && ch.messaging_connection === "instagram_login") {
    return "/api/oauth/instagram-login";
  }
  const start = oauthStartHref(ch.platform);
  if (ch.connection_mode === "oauth" && start) return start; // hosted OAuth flow
  return `/channels/${ch.id}`; // manual_token (or oauth without a hosted flow) → paste a fresh token
}
