import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("runs scrypt and returns false for a well-formed dummy hash (used to equalise login timing)", async () => {
    const dummy = `${"0".repeat(32)}:${"0".repeat(128)}`;
    expect(await verifyPassword("anything", dummy)).toBe(false);
  });

  it("returns false (no throw) for a malformed stored hash", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});
