import { describe, it, expect } from "vitest";
import { truncateCodePoints } from "./text";

// A lone (unpaired) UTF-16 surrogate anywhere in the string — the mojibake hazard.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("truncateCodePoints", () => {
  it("returns the string unchanged when at or under the limit", () => {
    expect(truncateCodePoints("hello", 255)).toBe("hello");
    expect(truncateCodePoints("😀😀", 2)).toBe("😀😀");
  });

  it("counts an emoji as one code point", () => {
    expect(truncateCodePoints("😀😀😀", 2)).toBe("😀😀");
  });

  it("never splits an astral character at the boundary (no lone surrogate)", () => {
    // "a" + emojis → a UTF-16 .slice(0,255) would land mid-emoji (lone surrogate).
    const s = "a" + "😀".repeat(300);
    const out = truncateCodePoints(s, 255);
    expect([...out].length).toBe(255);
    expect(loneSurrogate.test(out)).toBe(false);
  });
});
