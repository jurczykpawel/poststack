import { describe, it, expect } from "vitest";
import { applyPersonalization, hasPlaceholders, responseConfigHasPlaceholders } from "@/lib/rules/personalization";

describe("hasPlaceholders", () => {
  it("detects supported placeholders", () => {
    expect(hasPlaceholders("Cześć {imie}!")).toBe(true);
    expect(hasPlaceholders("Hi {name}")).toBe(true);
  });
  it("is false for plain text / empty", () => {
    expect(hasPlaceholders("Cześć!")).toBe(false);
    expect(hasPlaceholders("")).toBe(false);
    expect(hasPlaceholders(null)).toBe(false);
    expect(hasPlaceholders("{unknown}")).toBe(false);
  });
});

describe("applyPersonalization (licensed)", () => {
  const on = (displayName: string | null) => ({ displayName, enabled: true });

  it("substitutes the first name for {imie}", () => {
    expect(applyPersonalization("Cześć {imie}!", on("Jan Kowalski"))).toBe("Cześć Jan!");
  });
  it("substitutes the full name for {name}", () => {
    expect(applyPersonalization("Witaj {name}", on("Jan Kowalski"))).toBe("Witaj Jan Kowalski");
  });
  it("handles both placeholders together", () => {
    expect(applyPersonalization("{imie} ({name})", on("Anna Nowak"))).toBe("Anna (Anna Nowak)");
  });
  it("tidies leftover space/punctuation when the name is missing", () => {
    expect(applyPersonalization("Cześć {imie}!", on(null))).toBe("Cześć!");
    expect(applyPersonalization("Cześć {imie}, miło Cię widzieć", on("  "))).toBe("Cześć, miło Cię widzieć");
  });
});

describe("applyPersonalization (unlicensed — runtime-safe strip)", () => {
  it("never leaks a literal placeholder when the feature is off", () => {
    const out = applyPersonalization("Cześć {imie}! {name}", { displayName: "Jan Kowalski", enabled: false });
    expect(out).not.toContain("{imie}");
    expect(out).not.toContain("{name}");
    expect(out).not.toContain("Jan"); // no personal data leaked either
    expect(out).toBe("Cześć!");
  });
});

describe("responseConfigHasPlaceholders", () => {
  it("scans text, pools, comment texts, and follow-gate branches", () => {
    expect(responseConfigHasPlaceholders({ text: "Hi {imie}" })).toBe(true);
    expect(responseConfigHasPlaceholders({ messages: ["plain", "yo {name}"] })).toBe(true);
    expect(responseConfigHasPlaceholders({ comment_reply_text: "thanks {imie}" })).toBe(true);
    expect(responseConfigHasPlaceholders({ comment_reply_texts: ["a", "b {name}"] })).toBe(true);
    expect(responseConfigHasPlaceholders({ followed: { text: "yo {imie}" } })).toBe(true);
    expect(responseConfigHasPlaceholders({ not_followed: { text: "hey {name}" } })).toBe(true);
    expect(responseConfigHasPlaceholders({ text: "plain", texts: ["also plain"] })).toBe(false);
    expect(responseConfigHasPlaceholders({})).toBe(false);
  });
});
