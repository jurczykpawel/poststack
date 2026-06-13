import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, clampLimit } from "./pagination";

describe("tuple cursor", () => {
  it("round-trips a {createdAt, id} cursor", () => {
    const c = { createdAt: "2026-06-09T10:00:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("produces an opaque (non-plaintext) token", () => {
    const token = encodeCursor({ createdAt: "2026-06-09T10:00:00.000Z", id: "abc" });
    expect(token).not.toContain("abc");
  });

  it("returns null for a malformed cursor instead of throwing", () => {
    expect(decodeCursor("not-a-valid-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("clampLimit defaults and caps", () => {
    expect(clampLimit(undefined)).toBe(20);
    expect(clampLimit("0")).toBe(20);
    expect(clampLimit("5")).toBe(5);
    expect(clampLimit("9999")).toBe(100);
  });
});
