import { describe, it, expect } from "vitest";
import { sanitizeForLog, neutralizeHtml } from "./safe-log";

describe("sanitizeForLog", () => {
  it("strips CR/LF from a value", () => {
    expect(sanitizeForLog("1.2.3.4\r\nFAKE 200 OK")).toBe("1.2.3.4FAKE 200 OK");
  });

  it("strips control characters (tab, null, DEL)", () => {
    expect(sanitizeForLog("a\tb\x00c\x7f")).toBe("abc");
  });

  it("leaves a clean value unchanged", () => {
    expect(sanitizeForLog("203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("neutralizeHtml", () => {
  it("maps <, >, & to fullwidth look-alikes", () => {
    expect(neutralizeHtml('<script>alert(1)</script> & "stuff"')).toBe("＜script＞alert(1)＜/script＞ ＆ \"stuff\"");
  });

  it("leaves a clean value unchanged", () => {
    expect(neutralizeHtml("hello world")).toBe("hello world");
  });
});
