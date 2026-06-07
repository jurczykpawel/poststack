import { describe, it, expect } from "vitest";
import { sanitizeForLog } from "./safe-log";

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
