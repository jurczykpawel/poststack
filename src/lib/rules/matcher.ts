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

/**
 * Test whether a rule matches an incoming event.
 *
 * @param rule - The rule candidate to test
 * @param text - Normalized message/comment text (may be null for empty messages)
 * @param eventType - "message" | "comment"
 * @returns true if the rule matches
 */
export function matchRule(
  rule: RuleCandidate,
  text: string | null,
  eventType: EventType
): boolean {
  if (!rule.is_active) return false;

  const { trigger_type, trigger_config } = rule;
  const normalized = (text ?? "").toLowerCase().trim();

  switch (trigger_type) {
    case "keyword":
      if (eventType !== "message") return false;
      return matchKeywords(normalized, trigger_config);

    case "comment_keyword":
      if (eventType !== "comment") return false;
      return matchKeywords(normalized, trigger_config);

    case "welcome":
      return eventType === "message";

    case "default":
      return eventType === "message";

    case "postback": {
      // postback payload matching is handled separately (not text-based)
      return false;
    }

    case "story_reply":
    case "story_mention":
      return eventType === "message";

    default:
      return false;
  }
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
