import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";

// historyRetentionField is the zod schema fragment, exported for unit testing in isolation.
// env.ts calls loadEnv() at module level, so required vars must be set before the import.

let historyRetentionField: typeof import("./env").historyRetentionField;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "x".repeat(32);
  process.env.CRON_SECRET = "x".repeat(32);
  process.env.APP_URL = "http://localhost:3000";
  process.env.ENCRYPTION_KEY = "a".repeat(40);
  ({ historyRetentionField } = await import("./env"));
});

describe("HISTORY_RETENTION_DAYS validation", () => {
  it("defaults to 60 when unset", () => {
    expect(z.object({ x: historyRetentionField }).parse({}).x).toBe(60);
  });
  it("0 disables (allowed)", () => {
    expect(z.object({ x: historyRetentionField }).parse({ x: "0" }).x).toBe(0);
  });
  it("rejects a positive value below 30 (would break windowed reads)", () => {
    expect(() => z.object({ x: historyRetentionField }).parse({ x: "10" })).toThrow();
  });
  it("accepts a value >= 30", () => {
    expect(z.object({ x: historyRetentionField }).parse({ x: "90" }).x).toBe(90);
  });
});
