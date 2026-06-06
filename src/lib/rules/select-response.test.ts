import { describe, it, expect } from "vitest";
import { selectResponse } from "./response";

describe("selectResponse — text source × AI post-processing", () => {
  it("text: returns the single text, AI off", () => {
    expect(selectResponse("text", { text: "hi" })).toEqual({ baseText: "hi", aiEnabled: false });
  });

  it("ai_rephrase: returns text with AI on", () => {
    expect(selectResponse("ai_rephrase", { text: "hi" })).toEqual({ baseText: "hi", aiEnabled: true });
  });

  it("random_text: picks a member of the pool, AI off", () => {
    const pool = ["a", "b", "c"];
    for (let i = 0; i < 20; i++) {
      const { baseText, aiEnabled } = selectResponse("random_text", { messages: pool });
      expect(pool).toContain(baseText);
      expect(aiEnabled).toBe(false);
    }
  });

  it("random_text + ai_rephrase flag: picks from the pool AND enables AI (the chain)", () => {
    const pool = ["a", "b"];
    const { baseText, aiEnabled } = selectResponse("random_text", { messages: pool, ai_rephrase: true });
    expect(pool).toContain(baseText);
    expect(aiEnabled).toBe(true);
  });

  it("text + ai_rephrase flag: enables AI on a single text", () => {
    expect(selectResponse("text", { text: "hi", ai_rephrase: true })).toEqual({ baseText: "hi", aiEnabled: true });
  });

  it("random_text with an empty pool yields no base text", () => {
    expect(selectResponse("random_text", { messages: [] })).toEqual({ baseText: null, aiEnabled: false });
  });

  it("none / sequence yield no base text and no AI", () => {
    expect(selectResponse("none", { text: "ignored" })).toEqual({ baseText: null, aiEnabled: false });
    expect(selectResponse("sequence", {})).toEqual({ baseText: null, aiEnabled: false });
  });
});
