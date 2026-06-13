import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/z";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
});

describe("tier count-limits", () => {
  it("limitFor: free is capped, pro/business unlimited", async () => {
    const { limitFor } = await import("./gate");
    expect(limitFor("free", "apiKeys")).toBe(1);
    expect(limitFor("free", "brands")).toBe(1);
    expect(limitFor("pro", "apiKeys")).toBe(Infinity);
    expect(limitFor("business", "brands")).toBe(Infinity);
    expect(limitFor(null, "apiKeys")).toBe(1); // null → free
  });

  it("assertWithinLimit: free allows the 1st, blocks the 2nd; pro is unlimited", async () => {
    const { assertWithinLimit, LimitExceededError } = await import("./gate");
    expect(() => assertWithinLimit("free", "apiKeys", 0)).not.toThrow(); // creating the 1st
    expect(() => assertWithinLimit("free", "apiKeys", 1)).toThrow(LimitExceededError); // the 2nd
    expect(() => assertWithinLimit("free", "brands", 1)).toThrow(LimitExceededError);
    expect(() => assertWithinLimit("pro", "apiKeys", 99)).not.toThrow();
    expect(() => assertWithinLimit("business", "brands", 99)).not.toThrow();
  });

  it("LimitExceededError carries the kind and limit", async () => {
    const { assertWithinLimit, LimitExceededError } = await import("./gate");
    try {
      assertWithinLimit("free", "apiKeys", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LimitExceededError);
      const err = e as InstanceType<typeof LimitExceededError>;
      expect(err.kind).toBe("apiKeys");
      expect(err.limit).toBe(1);
    }
  });
});
