import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let rateLimit: typeof import("./rate-limit").rateLimit;

const KEY = "test:rate:key";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  ({ rateLimit } = await import("./rate-limit"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table rate_limit_counters"));
});

afterAll(async () => {
  if (db) await db.$client.end();
});

describe("rateLimit (real Postgres, fixed window)", () => {
  it("allows the first hit and reports remaining", async () => {
    if (!TEST_DB) return;
    const r = await rateLimit(KEY, 5, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.retryAfter).toBe(0);
  });

  it("blocks once the limit is exceeded within the window", async () => {
    if (!TEST_DB) return;
    expect((await rateLimit(KEY, 2, 60)).allowed).toBe(true);
    expect((await rateLimit(KEY, 2, 60)).allowed).toBe(true);
    const third = await rateLimit(KEY, 2, 60);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfter).toBeGreaterThan(0);
  });

  it("resets the count once the window has elapsed", async () => {
    if (!TEST_DB) return;
    await rateLimit(KEY, 2, 60);
    // Age the window past its end.
    await db.execute(
      sql.raw("update rate_limit_counters set window_start = now() - interval '61 seconds'"),
    );
    const r = await rateLimit(KEY, 2, 60);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1); // fresh window, count reset to 1
  });

  it("loses no increments under concurrency (exactly `limit` allowed)", async () => {
    if (!TEST_DB) return;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rateLimit(KEY, 3, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});
