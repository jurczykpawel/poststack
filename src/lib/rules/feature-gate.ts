// Maps an auto-reply rule to the PRO features it uses, and decides whether a
// create/update is allowed under the current license. Free rules (a plain keyword
// → text reply) require nothing; everything richer is gated.

import type { Feature } from "@/lib/license/features";
import { hasFeature } from "@/lib/license/gate";
import { responseConfigHasPlaceholders } from "./personalization";

function branchHasInteractive(branch: unknown): boolean {
  const b = (branch ?? {}) as Record<string, unknown>;
  return (Array.isArray(b.quick_replies) && b.quick_replies.length > 0) || (Array.isArray(b.buttons) && b.buttons.length > 0);
}

function hasInteractive(config: Record<string, unknown>): boolean {
  return branchHasInteractive(config) || branchHasInteractive(config.followed) || branchHasInteractive(config.not_followed);
}

/** The PRO features a rule with this trigger + response would use (empty for a free rule).
 *  Free triggers are keyword (DM) and comment_keyword (comment); a reaction-fired rule is PRO. */
export function requiredRuleFeatures(
  responseType: string,
  responseConfig: Record<string, unknown>,
  triggerType?: string,
): Feature[] {
  const feats: Feature[] = [];
  if (triggerType === "reaction") feats.push("reaction_trigger");
  if (responseConfigHasPlaceholders(responseConfig)) feats.push("personalization");
  if (responseType === "ai_rephrase" || responseConfig.ai_rephrase === true) feats.push("ai_rephrase");
  if (responseType === "follow_gate") feats.push("follow_gate");
  if (hasInteractive(responseConfig)) feats.push("interactive_messages");
  return feats;
}

/**
 * The first PRO feature a rule needs but the instance isn't licensed for, or null if allowed.
 * On update, pass `before` so features already present on the rule are grandfathered — a
 * licensed-then-lapsed rule stays editable (toggle/rename), only NEWLY added PRO use is blocked.
 */
export async function firstUnlicensedRuleFeature(
  after: { responseType: string; responseConfig: Record<string, unknown>; triggerType?: string },
  before?: { responseType: string; responseConfig: Record<string, unknown>; triggerType?: string },
): Promise<Feature | null> {
  const grandfathered = before
    ? new Set(requiredRuleFeatures(before.responseType, before.responseConfig, before.triggerType))
    : new Set<Feature>();
  for (const f of requiredRuleFeatures(after.responseType, after.responseConfig, after.triggerType)) {
    if (!grandfathered.has(f) && !(await hasFeature(f))) return f;
  }
  return null;
}
