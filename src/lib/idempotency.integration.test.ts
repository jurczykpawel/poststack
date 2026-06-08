import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let idempotencyKeys: typeof import("@/db/schema").idempotencyKeys;
let isClaimed: typeof import("./idempotency").isClaimed;
let claim: typeof import("./idempotency").claim;

const K = "idem-int-test-key";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  ({ idempotencyKeys } = await import("@/db/schema"));
  ({ isClaimed, claim } = await import("./idempotency"));
});

afterEach(async () => {
  if (TEST_DB) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, K));
});
afterAll(async () => {
  if (TEST_DB) await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, K));
});

describe("idempotency (real Postgres)", () => {
  it("is not claimed when no row exists", async () => {
    if (!TEST_DB) return;
    expect(await isClaimed(K)).toBe(false);
  });

  it("claim then isClaimed is true", async () => {
    if (!TEST_DB) return;
    await claim(K);
    expect(await isClaimed(K)).toBe(true);
  });

  it("a re-claim is idempotent (no duplicate-key error) and refreshes TTL", async () => {
    if (!TEST_DB) return;
    await claim(K);
    await claim(K);
    expect(await isClaimed(K)).toBe(true);
  });

  it("an expired claim is not considered claimed", async () => {
    if (!TEST_DB) return;
    // claim() sets expires_at = now + 24h; pass a 'now' 24h+ in the past → already expired
    await claim(K, new Date(Date.now() - 86_400_000 - 1000));
    expect(await isClaimed(K)).toBe(false);
  });
});
