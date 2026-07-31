import { describe, it, expect } from "vitest";
import { disclosureNote, AI_GENERATED_DEFAULT_NOTE, AI_ASSISTED_DEFAULT_NOTE } from "./note";

describe("disclosureNote", () => {
  it("is always null for level 'none', regardless of a custom note", () => {
    expect(disclosureNote("none", null)).toBeNull();
    expect(disclosureNote("none", undefined)).toBeNull();
    expect(disclosureNote("none", "some custom text")).toBeNull();
  });

  it("falls back to the built-in default per level when no custom note is given", () => {
    expect(disclosureNote("ai_generated", null)).toBe(AI_GENERATED_DEFAULT_NOTE);
    expect(disclosureNote("ai_generated", undefined)).toBe(AI_GENERATED_DEFAULT_NOTE);
    expect(disclosureNote("ai_assisted", null)).toBe(AI_ASSISTED_DEFAULT_NOTE);
    expect(disclosureNote("ai_assisted", undefined)).toBe(AI_ASSISTED_DEFAULT_NOTE);
  });

  it("uses a trimmed custom note when given one", () => {
    expect(disclosureNote("ai_generated", "  Made with a robot.  ")).toBe("Made with a robot.");
    expect(disclosureNote("ai_assisted", "Custom line")).toBe("Custom line");
  });

  it("an empty/whitespace-only custom note means 'explicitly no note', not 'use the default'", () => {
    expect(disclosureNote("ai_generated", "")).toBeNull();
    expect(disclosureNote("ai_generated", "   ")).toBeNull();
    expect(disclosureNote("ai_assisted", "")).toBeNull();
  });
});
