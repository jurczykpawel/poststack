import type { MetaTokenInfo } from "./meta-token";

export const FACEBOOK_VIDEO_CAROUSEL_HINT = "Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.";
export type VideoCarouselChannel = { video_carousel?: string };

export function facebookVideoCarouselState(info: MetaTokenInfo | null, pageId: string, tasks?: string[]): "unknown" | "unavailable" | "available" {
  if (!info || !info.appId || !info.isValid || (info.profileId && info.profileId !== pageId)) return "unknown";
  const grant = info.granularScopes?.find(scope => scope.scope === "pages_manage_ads");
  if (!info.scopes.includes("pages_manage_ads") || (info.granularScopes && !grant) || (grant?.target_ids && !grant.target_ids.includes(pageId)) || (tasks && !tasks.includes("ADVERTISE"))) return "unavailable";
  if (!grant || !tasks) return "unknown";
  return "available";
}
