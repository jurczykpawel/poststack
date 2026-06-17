import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels } from "@/db/schema";
import { channelMatchesPlatform } from "@/lib/channels/platform-match";
import { isBrandLocked } from "./access";

/** Editorial platforms a brand can designate a channel for. */
export const EDITORIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "threads",
  "x",
  "linkedin",
] as const;
export type EditorialPlatform = (typeof EDITORIAL_PLATFORMS)[number];

export interface ResolvedChannel {
  id: string;
  label: string;
}

export interface BrandPlatformSlot {
  platform: string;
  channel: ResolvedChannel | null;
  ambiguous: boolean;
}

function liveChannelsOfBrand(workspaceId: string, brandKey: string) {
  return db.query.channels.findMany({
    where: and(
      eq(channels.workspace_id, workspaceId),
      eq(channels.brand_key, brandKey),
      ne(channels.status, "disabled"),
      isNull(channels.deleted_at),
    ),
  });
}

/**
 * The single live channel a brand publishes to on an editorial platform, scoped to the workspace, or
 * null if there is none OR more than one (ambiguous → never guess). Reuses channelMatchesPlatform so
 * resolution can't drift from the publish guard (PSA44).
 */
export async function resolveChannelForBrandPlatform(
  workspaceId: string,
  brandKey: string,
  platform: string,
): Promise<ResolvedChannel | null> {
  // BRANDLIMIT1: a brand locked beyond the tier limit never resolves a channel → never publishes.
  // This is the runtime authority backing the UI lock (server-side, mirrors auto_story/first_comment).
  if (await isBrandLocked(workspaceId, brandKey)) return null;
  const rows = await liveChannelsOfBrand(workspaceId, brandKey);
  const matches = rows.filter((c) => channelMatchesPlatform(platform, c));
  if (matches.length !== 1) return null;
  const c = matches[0]!;
  return { id: c.id, label: c.display_name ?? c.platform_id };
}

/** Per-editorial-platform resolution summary for a brand (drives the Brands setup screen). */
export async function resolveBrandSlots(workspaceId: string, brandKey: string): Promise<BrandPlatformSlot[]> {
  const rows = await liveChannelsOfBrand(workspaceId, brandKey);
  return EDITORIAL_PLATFORMS.map((platform) => {
    const matches = rows.filter((c) => channelMatchesPlatform(platform, c));
    const channel =
      matches.length === 1
        ? { id: matches[0]!.id, label: matches[0]!.display_name ?? matches[0]!.platform_id }
        : null;
    return { platform, channel, ambiguous: matches.length > 1 };
  });
}
