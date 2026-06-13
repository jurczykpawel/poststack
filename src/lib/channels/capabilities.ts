import type { Platform } from "@/db/schema";
import { isPublishablePlatform, getProviderForPlatform, providerIdForPlatform } from "@/lib/providers";
import { getProvider as getInboundProvider, getSupportedPlatforms } from "@/lib/platforms/registry";

/**
 * CHANNELS-ARCHITECTURE (Task 6) — the one unifying idea: a channel is an account with a set of
 * CAPABILITIES, NOT a "publish channel" vs a "reply channel". Capabilities are COMPUTED from
 * `platform × connection_mode × provider`, never stored as the source of truth (a display copy may
 * be cached in `channels.metadata.capabilities`). The engine asks `can(channel, "publish")` /
 * `can(channel, "dm")` and never branches on platform — adding a platform or a capability never
 * forks the model.
 */
export const CAPABILITIES = [
  "publish",
  "comment_reply",
  "dm",
  "poll_comments",
  "receive_webhooks",
  "enumerate_subaccounts",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export interface ChannelCapabilityCtx {
  platform: string;
  connection_mode?: "oauth" | "manual_token" | "derived";
  /** Reserved for scope-refined resolution (e.g. an OAuth channel missing a publish scope). */
  metadata?: Record<string, unknown> | null;
}

// Resolved lazily (not at module load) so importing this file has no side effect and partial mocks
// of the registry in unrelated tests don't have to provide getSupportedPlatforms.
const inboundPlatforms = (): Set<string> => new Set<string>(getSupportedPlatforms());

/**
 * Resolve the capability set for a channel. Folds the PUBLISH provider (one per platform, FB/IG→meta)
 * together with the INBOUND provider (it owns its own inbound capabilities), plus the managed-
 * connection seam: a non-derived credential on a source-capable provider can enumerate sub-accounts;
 * a minted (`derived`) child descends from its source and never enumerates further.
 */
export function channelCapabilities(ctx: ChannelCapabilityCtx): Capability[] {
  const caps = new Set<Capability>();

  if (isPublishablePlatform(ctx.platform)) {
    caps.add("publish");
    const provider = getProviderForPlatform(ctx.platform);
    if (provider.supportsSources?.() && ctx.connection_mode !== "derived") {
      caps.add("enumerate_subaccounts");
    }
  }

  if (inboundPlatforms().has(ctx.platform)) {
    for (const c of getInboundProvider(ctx.platform as Platform).inboundCapabilities()) caps.add(c);
  }

  return [...caps];
}

/** The engine's only question about a channel: what can it do? */
export function can(ctx: ChannelCapabilityCtx, capability: Capability): boolean {
  return channelCapabilities(ctx).includes(capability);
}

/** True when no platform branch is needed: the platform is unknown to both registries. */
export function isKnownPlatform(platform: string): boolean {
  return isPublishablePlatform(platform) || inboundPlatforms().has(platform) || providerIdForPlatform(platform) !== platform;
}
