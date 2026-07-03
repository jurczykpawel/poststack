import { providers } from "./registry";
import { metaProvider } from "./meta";
import { youtubeProvider } from "./youtube";
import { tiktokProvider } from "./tiktok";
import { xProvider } from "./x";
import { linkedinProvider } from "./linkedin";
import { threadsProvider } from "./threads";

// The publish-side providers (one per platform). meta serves FB+IG publish; the inbound side lives
// in @/lib/platforms (facebook/instagram/youtube) and shares the Meta token/app-secret model. The
// channel-level unification (one account both publishes AND replies) is the Task 6 capability model.
providers.register(metaProvider);
providers.register(youtubeProvider);
providers.register(tiktokProvider);
providers.register(xProvider);
providers.register(linkedinProvider);
providers.register(threadsProvider);

import { getProvider, isProvider } from "./registry";

// Platform→provider alias. RS stores facebook/instagram as distinct platforms (inbound model) and
// twitter for X, but the publish providers are keyed meta (FB+IG) / x. This bridges the two so
// `getProviderForPlatform(channel.platform)` resolves correctly for every channel. (CHANNELS-
// ARCHITECTURE: one provider per platform, capability-gated — meta serves FB+IG.)
const PLATFORM_PROVIDER_ALIAS: Record<string, string> = {
  facebook: "meta",
  instagram: "meta",
  twitter: "x",
};

export function providerIdForPlatform(platform: string): string {
  return PLATFORM_PROVIDER_ALIAS[platform] ?? platform;
}

// Reverse of the alias for the OAuth connect flow: its URL is keyed by PROVIDER id (/connect/:id).
// For every connectable provider that id equals the RS platform value — except X, whose provider is
// "x" but whose channel platform is "twitter". Map the connect id to the platform a channel must be
// stored under, so /connect/x writes platform "twitter" (valid enum) not "x" (which the DB rejects).
const CONNECT_ID_TO_PLATFORM: Record<string, string> = { x: "twitter" };
export function platformForConnectId(connectId: string): string {
  return CONNECT_ID_TO_PLATFORM[connectId] ?? connectId;
}

/** The publish provider for a channel's platform (resolves FB/IG→meta, twitter→x). */
export function getProviderForPlatform(platform: string) {
  return getProvider(providerIdForPlatform(platform));
}

/** Whether a channel platform has a registered publish provider. */
export function isPublishablePlatform(platform: string): boolean {
  return isProvider(providerIdForPlatform(platform));
}

/**
 * The meta subKind implied by a RS platform value, so the meta publish provider can route FB-vs-IG
 * for channels that don't carry an explicit `metadata.subKind` (RS inbound FB/IG channels). A
 * managed-connection channel's stored subKind always wins over this.
 */
export function subKindForPlatform(platform: string): string | undefined {
  if (platform === "facebook") return "facebook_page";
  if (platform === "instagram") return "instagram";
  return undefined;
}

export { getProvider, isProvider, listProviders, providers } from "./registry";
export type { Provider, FormatCapability, PublishRequest, AccountInfo } from "./types";
