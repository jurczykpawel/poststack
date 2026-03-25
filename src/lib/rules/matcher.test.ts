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
  it("matches comment type with keyword", () => {
    const rule: RuleCandidate = {
      ...baseRule,
      trigger_type: "comment_keyword",
      trigger_config: {
        keywords: [{ value: "info", match_type: "contains" }],
      },
    };
    expect(matchRule(rule, "need more info please", "comment")).toBe(true);
    expect(matchRule(rule, "need more info please", "message")).toBe(false);
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
