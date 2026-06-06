import { describe, it, expect } from "vitest";
import { matchRule } from "./matcher";
import type { RuleCandidate } from "./matcher";

const baseRule: Omit<RuleCandidate, "trigger_type" | "trigger_config"> = {
  id: "rule-1",
  is_active: true,
  priority: 0,
  cooldown_seconds: 0,
  response_type: "text",
  response_config: { text: "Hello!" },
  actions: [],
};

describe("matchRule — keyword trigger", () => {
  it("matches exact keyword (case-insensitive)", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: {
        keywords: [{ value: "hello", match_type: "exact" }],
      },
    };
    expect(matchRule(rule, "HELLO", "message")).toBe(true);
    expect(matchRule(rule, "hello world", "message")).toBe(false);
  });

  it("matches contains keyword", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: {
        keywords: [{ value: "promo", match_type: "contains" }],
      },
    };
    expect(matchRule(rule, "I want a promo code", "message")).toBe(true);
    expect(matchRule(rule, "no deal", "message")).toBe(false);
  });

  it("matches starts_with keyword", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: {
        keywords: [{ value: "start", match_type: "starts_with" }],
      },
    };
    expect(matchRule(rule, "Start me up", "message")).toBe(true);
    expect(matchRule(rule, "re-start", "message")).toBe(false);
  });

  it("matches any keyword in list", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: {
        keywords: [
          { value: "buy", match_type: "exact" },
          { value: "order", match_type: "exact" },
        ],
      },
    };
    expect(matchRule(rule, "buy", "message")).toBe(true);
    expect(matchRule(rule, "ORDER", "message")).toBe(true);
    expect(matchRule(rule, "looking", "message")).toBe(false);
  });
});

describe("matchRule — comment_keyword trigger", () => {
  it("matches keyword on any post (no post_id)", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "comment_keyword",
      trigger_config: {
        keywords: [{ value: "info", match_type: "contains" }],
      },
    };
    expect(matchRule(rule, { text: "need more info please", eventType: "comment" })).toBe(true);
    expect(matchRule(rule, { text: "need more info please", eventType: "message" })).toBe(false);
  });

  it("matches keyword only on specific post (post_id set)", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "comment_keyword",
      trigger_config: {
        post_id: "post-123",
        keywords: [{ value: "want", match_type: "contains" }],
      },
    };
    // Correct post + keyword = match
    expect(matchRule(rule, { text: "I want this", eventType: "comment", postId: "post-123" })).toBe(true);
    // Wrong post = no match
    expect(matchRule(rule, { text: "I want this", eventType: "comment", postId: "post-other" })).toBe(false);
    // No post = no match
    expect(matchRule(rule, { text: "I want this", eventType: "comment" })).toBe(false);
  });

  it("matches any comment on specific post (post_id, no keywords)", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "comment_keyword",
      trigger_config: {
        post_id: "post-456",
      },
    };
    // Any text on correct post = match
    expect(matchRule(rule, { text: "anything at all", eventType: "comment", postId: "post-456" })).toBe(true);
    // Wrong post = no match
    expect(matchRule(rule, { text: "anything", eventType: "comment", postId: "post-other" })).toBe(false);
  });

  it("rejects rule with no post_id and no keywords", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "comment_keyword",
      trigger_config: {},
    };
    expect(matchRule(rule, { text: "anything", eventType: "comment" })).toBe(false);
  });
});

describe("matchRule — default trigger", () => {
  it("matches any message when no other rule fired", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "default",
      trigger_config: {},
    };
    expect(matchRule(rule, "anything", "message")).toBe(true);
    expect(matchRule(rule, "", "message")).toBe(true);
  });

  it("does NOT match comments", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "default",
      trigger_config: {},
    };
    expect(matchRule(rule, "anything", "comment")).toBe(false);
  });
});

describe("matchRule — welcome trigger", () => {
  it("always matches on message type", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "welcome",
      trigger_config: {},
    };
    expect(matchRule(rule, null, "message")).toBe(true);
  });
});

describe("matchRule — postback trigger", () => {
  it("matches exact postback payload", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: { payload: "GET_STARTED" },
    };
    expect(matchRule(rule, { text: null, eventType: "message", postbackPayload: "GET_STARTED" })).toBe(true);
    expect(matchRule(rule, { text: null, eventType: "message", postbackPayload: "OTHER" })).toBe(false);
  });

  it("matches quick reply payload as postback", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: { payload: "yes_confirm" },
    };
    expect(matchRule(rule, { text: "Yes", eventType: "message", quickReplyPayload: "yes_confirm" })).toBe(true);
  });

  it("is case-insensitive", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: { payload: "BUY_NOW" },
    };
    expect(matchRule(rule, { text: null, eventType: "message", postbackPayload: "buy_now" })).toBe(true);
  });

  it("does not match without payload", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: { payload: "test" },
    };
    expect(matchRule(rule, { text: "test", eventType: "message" })).toBe(false);
  });

  it("does not match on comment events", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: { payload: "test" },
    };
    expect(matchRule(rule, { text: null, eventType: "comment", postbackPayload: "test" })).toBe(false);
  });

  it("rejects rule with no payload config", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "postback",
      trigger_config: {},
    };
    expect(matchRule(rule, { text: null, eventType: "message", postbackPayload: "anything" })).toBe(false);
  });
});

describe("matchRule — story_reply / story_mention triggers", () => {
  const storyReplyRule: RuleCandidate = { ...baseRule, trigger_type: "story_reply", trigger_config: {} };
  const storyMentionRule: RuleCandidate = { ...baseRule, trigger_type: "story_mention", trigger_config: {} };

  it("story_reply matches a message that is a reply to a story", () => {
    expect(matchRule(storyReplyRule, { text: "nice story", eventType: "message", isStoryReply: true })).toBe(true);
  });

  it("story_reply does NOT match a plain DM (no story context)", () => {
    expect(matchRule(storyReplyRule, { text: "nice story", eventType: "message" })).toBe(false);
  });

  it("story_reply does NOT match a comment", () => {
    expect(matchRule(storyReplyRule, { text: "nice story", eventType: "comment", isStoryReply: true })).toBe(false);
  });

  it("story_mention matches a message that mentions us in a story", () => {
    expect(matchRule(storyMentionRule, { text: null, eventType: "message", isStoryMention: true })).toBe(true);
  });

  it("story_mention does NOT match a plain DM", () => {
    expect(matchRule(storyMentionRule, { text: null, eventType: "message" })).toBe(false);
  });
});

describe("matchRule — reaction trigger", () => {
  const anyReaction: RuleCandidate = { ...baseRule, trigger_type: "reaction", trigger_config: {} };
  const loveOnly: RuleCandidate = { ...baseRule, trigger_type: "reaction", trigger_config: { reactions: ["love"] } };

  it("matches any reaction when no filter is set", () => {
    expect(matchRule(anyReaction, { text: null, eventType: "message", isReaction: true, reactionType: "wow" })).toBe(true);
  });

  it("does NOT match a plain message (no reaction)", () => {
    expect(matchRule(anyReaction, { text: "hi", eventType: "message" })).toBe(false);
  });

  it("does NOT match a comment", () => {
    expect(matchRule(anyReaction, { text: null, eventType: "comment", isReaction: true, reactionType: "love" })).toBe(false);
  });

  it("with a reactions filter, matches only the listed reaction types", () => {
    expect(matchRule(loveOnly, { text: null, eventType: "message", isReaction: true, reactionType: "love" })).toBe(true);
    expect(matchRule(loveOnly, { text: null, eventType: "message", isReaction: true, reactionType: "angry" })).toBe(false);
  });
});

describe("matchRule — welcome trigger edge case", () => {
  it("does NOT match on comment type", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "welcome",
      trigger_config: {},
    };
    expect(matchRule(rule, { text: "hello", eventType: "comment" })).toBe(false);
  });
});

describe("matchRule — null and edge case text", () => {
  it("keyword does not crash on null text", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hello", match_type: "exact" }] },
    };
    expect(matchRule(rule, { text: null, eventType: "message" })).toBe(false);
  });

  it("empty keyword value matches everything with contains (potential bug)", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "", match_type: "contains" }] },
    };
    // This documents current behavior -- empty string .includes("") is always true
    expect(matchRule(rule, { text: "anything", eventType: "message" })).toBe(true);
  });

  it("whitespace-only text is trimmed to empty string", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hello", match_type: "exact" }] },
    };
    expect(matchRule(rule, { text: "   ", eventType: "message" })).toBe(false);
  });

  it("unknown match_type does not match", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hello", match_type: "regex" }] },
    };
    expect(matchRule(rule, { text: "hello", eventType: "message" })).toBe(false);
  });
});

describe("matchRule — inactive rule", () => {
  it("never matches", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      is_active: false,
      trigger_type: "keyword",
      trigger_config: {
        keywords: [{ value: "hello", match_type: "exact" }],
      },
    };
    expect(matchRule(rule, "hello", "message")).toBe(false);
  });
});
