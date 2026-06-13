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
  };
}

export function fromTokenSet(ts: TokenSet): TokenData {
  return {
    access_token: ts.accessToken,
    refresh_token: ts.refreshToken,
    expires_at: ts.expiresAt ? Math.floor(Date.parse(ts.expiresAt) / 1000) : undefined,
  };
}
