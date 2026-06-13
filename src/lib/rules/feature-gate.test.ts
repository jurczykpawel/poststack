import { describe, it, expect, beforeAll } from "vitest";

// requiredRuleFeatures is pure, but its module transitively imports the license gate
// (env-validated), so set a valid env and import dynamically.
let requiredRuleFeatures: typeof import("./feature-gate").requiredRuleFeatures;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ requiredRuleFeatures } = await import("./feature-gate"));
});

describe("requiredRuleFeatures", () => {
  it("requires nothing for a plain keyword text reply (free)", () => {
    expect(requiredRuleFeatures("text", { text: "Cześć!" })).toEqual([]);
  });
  it("flags personalization placeholders", () => {
    expect(requiredRuleFeatures("text", { text: "Hi {imie}" })).toContain("personalization");
  });
  it("flags ai_rephrase by response_type or flag", () => {
    expect(requiredRuleFeatures("ai_rephrase", { text: "x" })).toContain("ai_rephrase");
    expect(requiredRuleFeatures("text", { text: "x", ai_rephrase: true })).toContain("ai_rephrase");
  });
  it("flags follow_gate", () => {
    expect(requiredRuleFeatures("follow_gate", { followed: { text: "a" }, not_followed: { text: "b" } })).toContain("follow_gate");
  });
  it("flags interactive when quick replies or buttons are present", () => {
    expect(requiredRuleFeatures("text", { text: "x", quick_replies: [{ title: "Y", payload: "Y" }] })).toContain("interactive_messages");
    expect(requiredRuleFeatures("text", { text: "x", buttons: [{ title: "B", payload: "B" }] })).toContain("interactive_messages");
  });
  it("flags interactive inside follow-gate branches", () => {
    const cfg = { followed: { text: "a", buttons: [{ title: "Go", payload: "GO" }] }, not_followed: { text: "b" } };
    expect(requiredRuleFeatures("follow_gate", cfg)).toContain("interactive_messages");
  });
  it("ignores empty interactive arrays", () => {
    expect(requiredRuleFeatures("text", { text: "x", quick_replies: [], buttons: [] })).toEqual([]);
  });
  it("can require several features at once", () => {
    const feats = requiredRuleFeatures("ai_rephrase", { text: "Hi {imie}", buttons: [{ title: "B", payload: "B" }] });
    expect(feats).toEqual(expect.arrayContaining(["personalization", "ai_rephrase", "interactive_messages"]));
  });
  it("flags the reaction trigger as PRO; keyword/comment triggers stay free", () => {
    expect(requiredRuleFeatures("text", { text: "x" }, "reaction")).toContain("reaction_trigger");
    expect(requiredRuleFeatures("text", { text: "x" }, "keyword")).not.toContain("reaction_trigger");
    expect(requiredRuleFeatures("text", { text: "x" }, "comment_keyword")).not.toContain("reaction_trigger");
    expect(requiredRuleFeatures("text", { text: "x" })).not.toContain("reaction_trigger");
  });
});
