import { describe, expect, it } from "vitest";
import { parseInsightJson, canonicalDecimal } from "./json";

describe("insights numeric JSON", () => {
  it("preserves integers, fractions and exponent tokens exactly", () => {
    expect(parseInsightJson(String.raw`{"large":9007199254740993,"fraction":1.2300,"exp":1.2e3,"text":"12 \"34\""}`))
      .toEqual({ large: "9007199254740993", fraction: "1.2300", exp: "1.2e3", text: '12 "34"' });
    expect(canonicalDecimal("9007199254740993")).toBe("9007199254740993");
    expect(canonicalDecimal("1.2300")).toBe("1.23");
    expect(canonicalDecimal("1.2e3")).toBe("1200");
    expect(canonicalDecimal("1e-3")).toBe("0.001");
    expect(canonicalDecimal("0")).toBe("0");
  });
  it("rejects malformed JSON and bounded decimal violations", () => {
    for (const text of ['{"v":01}', '{"v":NaN}', '{"v":1e}', '[1,]', '{"v":+1}', '1 2', '"open', '{"v":Infinity}']) {
      expect(() => parseInsightJson(text)).toThrow();
    }
    for (const value of ["-1", "Infinity", "1e999999", "1".repeat(513), Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => canonicalDecimal(value)).toThrow();
    }
  });
});
