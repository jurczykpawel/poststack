import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";

const TEST_DB = process.env.TEST_DATABASE_URL;
// Same constant scripts/migrate.ts uses to serialize startup migrations across replicas.
const MIGRATION_LOCK_KEY = 4815162342;

let pool: Pool;

beforeAll(() => {
  if (TEST_DB) pool = new Pool({ connectionString: TEST_DB });
});

afterAll(async () => {
  if (pool) await pool.end();
});

// migrate.ts sets `lock_timeout` before pg_advisory_lock so a replica whose lock-holder
// hangs mid-migration turns waiters into a fast, VISIBLE error (entrypoint crash-loop) rather than an
// indefinite silent hang. This guards the mechanism: a contended advisory lock with lock_timeout set
// must reject quickly, not block forever.
describe("migration advisory lock — lock_timeout", () => {
  it("a contended advisory lock with lock_timeout errors fast instead of hanging", async () => {
    if (!TEST_DB) return;
    const holder = await pool.connect();
    const waiter = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

      await waiter.query("SET lock_timeout = '1s'");
      const started = Date.now();
      await expect(
        waiter.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]),
      ).rejects.toThrow(/lock timeout/i);
      // It returned (rejected) rather than blocking indefinitely.
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
      holder.release();
      waiter.release();
    }
  });
});
