import type { Platform } from "@/db/schema";
import type { TokenData } from "@/lib/platforms/base";
import { getProvider } from "@/lib/platforms/registry";
import { TokenInvalidError } from "@/lib/platforms/errors";
import { getProviderForPlatform } from "@/lib/providers";
import { TokenInvalidError as PublishTokenInvalidError } from "@/lib/providers/errors";
import { toTokenSet } from "@/lib/providers/token-codec";
import { mergeRefreshedBlob } from "./token-refresh";

/** Shared refresh contract for the channel scan and worker. */
export function getTokenRefreshProvider(platform: Platform) {
  if (!["tiktok", "linkedin", "twitter", "threads"].includes(platform)) return getProvider(platform);
  const provider = getProviderForPlatform(platform);
  return {
    requiresTokenRefresh: () => provider.requiresTokenRefresh(),
    // These tokens can live for only a few hours; refresh on the preceding hourly scan.
    refreshBufferSeconds: () => 3600,
    async refreshToken(tokens: TokenData): Promise<TokenData> {
      try {
        const refreshed = await provider.refreshToken(toTokenSet(tokens));
        return mergeRefreshedBlob(tokens, refreshed);
      } catch (err) {
        if (err instanceof PublishTokenInvalidError) throw new TokenInvalidError(err.message);
        throw err;
      }
    },
  };
}
