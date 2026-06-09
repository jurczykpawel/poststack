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
  /** Quick reply payload (button tap within conversation) */
  quickReplyPayload?: string;
  /** Postback payload (button tap from persistent menu or template) */
  postbackPayload?: string;
  /** Message is a reply to one of our stories */
  isStoryReply?: boolean;
  /** Message mentions us in the sender's story */
  isStoryMention?: boolean;
  /** Event is an emoji reaction to one of our messages */
  isReaction?: boolean;
  /** Semantic reaction type (love, like, wow, sad, angry, dislike, smile, other) */
  reactionType?: string;
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
  // NFC-normalize before folding: Polish diacritics can arrive decomposed (NFD) while the keyword
  // is composed (NFC) or vice versa, and toLowerCase() does not normalize — so without this the
  // comparison silently fails on different code-unit forms of the same text.
  const normalized = (ctx.text ?? "").normalize("NFC").toLowerCase().trim();

  switch (trigger_type) {
    case "keyword":
      if (ctx.eventType !== "message") return false;
      return matchKeywords(normalized, trigger_config);

    case "comment_keyword":
      if (ctx.eventType !== "comment") return false;
      return matchCommentKeyword(normalized, trigger_config, ctx.postId);

    // welcome / default are catch-all rules for inbound MESSAGES. An emoji reaction arrives as
    // eventType:"message" + isReaction:true, so without the guard a reaction would trigger a DM
    // (unwanted, and a reaction is not a window-opening message). Reactions match only `reaction`
    // rules.
    //
    // NOTE: `welcome` is currently a behavioural ALIAS of `default` — both fire on every inbound
    // message. True first-contact gating (fire only on a contact's first-ever message) needs an
    // `isNewContact` signal threaded from the worker into the match context; that's deferred, so
    // until then a `welcome` rule fires like a `default` one.
    case "welcome":
      return ctx.eventType === "message" && ctx.isReaction !== true;

    case "default":
      return ctx.eventType === "message" && ctx.isReaction !== true;

    case "postback": {
      if (ctx.eventType !== "message") return false;
      const rulePayload = (trigger_config.payload as string | undefined)?.toLowerCase();
      if (!rulePayload) return false;
      const incoming = (ctx.postbackPayload ?? ctx.quickReplyPayload ?? "").toLowerCase();
      return incoming === rulePayload;
    }

    case "story_reply":
      return ctx.eventType === "message" && ctx.isStoryReply === true;

    case "story_mention":
      return ctx.eventType === "message" && ctx.isStoryMention === true;

    case "reaction": {
      if (ctx.eventType !== "message" || ctx.isReaction !== true) return false;
      const allowed = trigger_config.reactions as string[] | undefined;
      if (allowed && allowed.length > 0) {
        return ctx.reactionType ? allowed.includes(ctx.reactionType) : false;
      }
      return true;
    }

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
    // NFC-normalize the keyword too, to match the normalized text it's compared against.
    const value = kw.value.normalize("NFC").toLowerCase().trim();
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
