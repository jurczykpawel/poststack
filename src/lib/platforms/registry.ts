import type { Platform } from "@prisma/client";
import type { SocialProvider } from "./base";

// Providers are imported lazily to avoid loading Meta SDK in worker if not needed
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

// Auto-register available providers
// Add new platforms here as they are implemented
import("./facebook").then(({ FacebookProvider }) => {
  registerProvider("facebook", () => new FacebookProvider());
});

import("./instagram").then(({ InstagramProvider }) => {
  registerProvider("instagram", () => new InstagramProvider());
});
