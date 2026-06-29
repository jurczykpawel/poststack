import type { TokenData } from "@/lib/platforms/base";
import type { TokenSet } from "./types";

// The boundary codec between the channel's stored credential (TokenData, snake_case — RS's inbound
// shape) and the publish-provider model (TokenSet, camelCase). The delivery engine and the token
// keeper convert here so neither model leaks into the other.

export function toTokenSet(td: TokenData): TokenSet {
  return {
    accessToken: td.access_token,
    refreshToken: td.refresh_token,
    // TokenData.expires_at is epoch seconds; TokenSet.expiresAt is ISO.
    expiresAt: typeof td.expires_at === "number" ? new Date(td.expires_at * 1000).toISOString() : undefined,
    // IGFU1: carry the IG-Login token so the publish path can route to graph.instagram.com when the
    // channel has no Facebook page token (single-login publish). Mirrors instagram.ts messagingTransport.
    messagingToken: typeof td.messaging_token === "string" ? td.messaging_token : undefined,
  };
}

export function fromTokenSet(ts: TokenSet): TokenData {
  return {
    access_token: ts.accessToken,
    refresh_token: ts.refreshToken,
    expires_at: ts.expiresAt ? Math.floor(Date.parse(ts.expiresAt) / 1000) : undefined,
    // Defense in depth: carry the IG-Login messaging token if the TokenSet has one. NOTE: this alone
    // can't preserve a channel's blob across a refresh — fromTokenSet has no slot for page_id /
    // user_access_token / messaging_token_expires_at — so the token-keeper must merge over the
    // current blob (see mergeRefreshedBlob in channels/token-refresh.ts), not rely on this.
    messaging_token: typeof ts.messagingToken === "string" ? ts.messagingToken : undefined,
  };
}
