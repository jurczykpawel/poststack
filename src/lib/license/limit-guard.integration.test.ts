import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, count } from "drizzle-orm";

// Real-Postgres test for the advisory-lock count-limit. Five concurrent creates against a free
// instance (apiKeys limit = 1) must yield exactly one success and four LimitExceededError — proving
// the count→assert→insert sequence is serialised, so a race can't overshoot the limit.
const TEST_DB = process.env.TEST_DATABASE_URL;

const WS = "eeeeeeee-0000-0000-0000-0000000000a1";

let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let createWithinLimit: typeof import("./limit-guard").createWithinLimit;
let LimitExceededError: typeof import("./gate").LimitExceededError;
let gate: typeof import("./gate");

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ createWithinLimit } = await import("./limit-guard"));
  gate = await import("./gate");
  ({ LimitExceededError } = gate);
});

beforeEach(async () => {
  if (!TEST_DB) return;
  // Free instance: no license token anywhere → tier null → free (apiKeys limit 1).
  await db.delete(schema.instanceLicense);
  gate.invalidateLicenseCache();
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.insert(schema.workspaces).values({ id: WS, name: "Limit race WS", slug: "limit-race-ws" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

describe("createWithinLimit (advisory-lock TOCTOU)", () => {
  it("5 concurrent creates on free → exactly 1 ok + 4 LimitExceededError", async () => {
    if (!TEST_DB) return;
    const attempt = (i: number) =>
      createWithinLimit("apiKeys", {
        count: async (tx) => {
          const [{ n }] = await tx
            .select({ n: count() })
            .from(schema.apiKeys)
            .where(eq(schema.apiKeys.workspace_id, WS));
          return Number(n);
        },
        create: (tx) =>
          tx.insert(schema.apiKeys).values({
            workspace_id: WS,
            name: `key-${i}`,
            key_hash: `hash-race-${i}`,
            key_prefix: `sk_live_r${i}`,
          }),
      });

    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(attempt));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LimitExceededError);
    }
    // and exactly one row actually landed
    const [{ n }] = await db
      .select({ n: count() })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.workspace_id, WS));
    expect(Number(n)).toBe(1);
  });

  it("exempt bypasses the limit (idempotent re-create path)", async () => {
    if (!TEST_DB) return;
    // Seed one key so the free limit is already reached.
    await db.insert(schema.apiKeys).values({
      workspace_id: WS, name: "seed", key_hash: "hash-seed", key_prefix: "sk_live_seed",
    });
    // An exempt create still goes through despite being over the limit.
    await expect(
      createWithinLimit("apiKeys", {
        exempt: async () => true,
        count: async () => 99,
        create: (tx) =>
          tx.insert(schema.apiKeys).values({
            workspace_id: WS, name: "exempt", key_hash: "hash-exempt", key_prefix: "sk_live_ex",
          }),
      }),
    ).resolves.toBeDefined();
  });
});
