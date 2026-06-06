import type { Platform } from "@/db/schema";
import type { SocialProvider } from "./base";
import { FacebookProvider } from "./facebook";
import { InstagramProvider } from "./instagram";

const providerFactories: Partial<Record<Platform, () => SocialProvider>> = {};

export function registerProvider(
  platform: Platform,
  factory: () => SocialProvider
): void {
  providerFactories[platform] = factory;
}

export function getProvider(platform: Platform): SocialProvider {
  const factory = providerFactories[platform];
  if (!factory) {
    throw new Error(
      `No provider registered for platform: ${platform}. ` +
        `Register it in src/lib/platforms/registry.ts`
    );
  }
  return factory();
}

export function getSupportedPlatforms(): Platform[] {
  return Object.keys(providerFactories) as Platform[];
}

// Auto-register available providers synchronously at module load so getProvider()
// is deterministic from the first call (no async registration race on cold start).
// Provider factories are lazy — the provider is only constructed on first use.
// Add new platforms here as they are implemented.
registerProvider("facebook", () => new FacebookProvider());
registerProvider("instagram", () => new InstagramProvider());
