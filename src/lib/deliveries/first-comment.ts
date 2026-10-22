import type { Platform } from "@/db/schema";
import type { PublishRequest } from "@/lib/providers/types";
import { hasFeature } from "@/lib/license/gate";
import { getProvider, getSupportedPlatforms } from "@/lib/platforms/registry";

export type FirstCommentSkipReason = "no_text" | "unlicensed" | "unsupported_platform";

/** Shared eligibility for enqueue and read-time explanation; an empty override suppresses defaults. */
export async function firstCommentEligibility(
  channel: { platform: Platform; default_first_comment: string | null },
  request: Pick<PublishRequest, "firstComment">,
): Promise<{ text: string; reason?: FirstCommentSkipReason }> {
  const text = (request.firstComment ?? channel.default_first_comment ?? "").trim();
  if (!text) return { text, reason: "no_text" };
  if (!(await hasFeature("first_comment"))) return { text, reason: "unlicensed" };
  if (!getSupportedPlatforms().includes(channel.platform) || !getProvider(channel.platform).commentOnPost) {
    return { text, reason: "unsupported_platform" };
  }
  return { text };
}
