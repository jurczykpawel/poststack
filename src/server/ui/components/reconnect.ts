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
}

export function reconnectHref(ch: ReconnectTarget): string {
  if (ch.connection_mode === "derived") return "/sources"; // re-auth the master token
  const start = oauthStartHref(ch.platform);
  if (ch.connection_mode === "oauth" && start) return start; // hosted OAuth flow
  return `/channels/${ch.id}`; // manual_token (or oauth without a hosted flow) → paste a fresh token
}
