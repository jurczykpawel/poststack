export type EventType = "message" | "comment";

export interface KeywordConfig {
  value: string;
  match_type: "exact" | "contains" | "starts_with";
}

export interface RuleCandidate {
  id: string;
  is_active: boolean;
  priority: number;
  cooldown_seconds: number;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  response_type: string;
  response_config: Record<string, unknown>;
  actions: unknown[];
}

export interface MatchContext {
  text: string | null;
  eventType: EventType;
  /** Post/media ID for comment events (used for post_id scoping) */
  postId?: string;
}

/**
 * Test whether a rule matches an incoming event.
 */
export function matchRule(
  rule: RuleCandidate,
  textOrContext: string | null | MatchContext,
  eventType?: EventType
): boolean {
  // Support both old signature (text, eventType) and new (MatchContext)
  const ctx: MatchContext =
    typeof textOrContext === "object" && textOrContext !== null && "eventType" in textOrContext
      ? textOrContext
      : { text: textOrContext as string | null, eventType: eventType!, postId: undefined };
  if (!rule.is_active) return false;

  const { trigger_type, trigger_config } = rule;
  const normalized = (ctx.text ?? "").toLowerCase().trim();

  switch (trigger_type) {
    case "keyword":
      if (ctx.eventType !== "message") return false;
      return matchKeywords(normalized, trigger_config);

    case "comment_keyword":
      if (ctx.eventType !== "comment") return false;
      return matchCommentKeyword(normalized, trigger_config, ctx.postId);

    case "welcome":
      return ctx.eventType === "message";

    case "default":
      return ctx.eventType === "message";

    case "postback": {
      // postback payload matching is handled separately (not text-based)
      return false;
    }

    case "story_reply":
    case "story_mention":
      return ctx.eventType === "message";

    default:
      return false;
  }
}

/**
 * Match comment_keyword rules with optional post_id scoping.
 *
 * Supports 3 modes:
 * 1. post_id set + keywords set: match keyword on specific post only
 * 2. post_id set + no keywords: match ANY comment on specific post
 * 3. no post_id + keywords set: match keyword on any post
 */
function matchCommentKeyword(
  text: string,
  config: Record<string, unknown>,
  postId?: string
): boolean {
  const rulePostId = config.post_id as string | undefined;
  const keywords = config.keywords as KeywordConfig[] | undefined;
  const hasKeywords = keywords && keywords.length > 0;

  // If rule is scoped to a specific post, check post_id first
  if (rulePostId && rulePostId !== postId) {
    return false;
  }

  // If rule has keywords, match them
  if (hasKeywords) {
    return matchKeywords(text, config);
  }

  // If rule has post_id but no keywords, match any comment on that post
  if (rulePostId) {
    return true;
  }

  // No post_id, no keywords -- invalid rule config, don't match
  return false;
}

function matchKeywords(
  text: string,
  config: Record<string, unknown>
): boolean {
  const keywords = config.keywords as KeywordConfig[] | undefined;
  if (!keywords || keywords.length === 0) return false;

  return keywords.some((kw) => {
    const value = kw.value.toLowerCase().trim();
    switch (kw.match_type) {
      case "exact":
        return text === value;
      case "contains":
        return text.includes(value);
      case "starts_with":
        return text.startsWith(value);
      default:
        return false;
    }
  });
}
