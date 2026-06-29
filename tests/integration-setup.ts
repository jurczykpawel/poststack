import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { makeWorkerUtils } from "graphile-worker";
import { Pool } from "pg";

/**
 * Global setup for the integration suite. Brings the shared TEST_DATABASE_URL to a fully current
 * schema before any test file runs, in two parts:
 *
 *   1. The drizzle app migrations (the same mechanism as scripts/migrate.ts) — so the app tables
 *      always match the latest unreleased migration. Without this, a stale shared test DB missing a
 *      column (e.g. messaging_token_expires_at) would make the tests touching it self-skip, and the
 *      suite would report false-green while never running the new tests.
 *   2. The graphile_worker schema — emitEvent now enqueues an event-dispatch job transactionally
 *      (WHOUT1), so any test that emits an event / creates a contact / publishes a post / transitions
 *      a channel needs the queue schema present, even if it never inspects the queue.
 *
 * We HARD-FAIL when TEST_DATABASE_URL is unset: running the integration config without a DB used to
 * `return` here and let every suite self-skip, reporting a false-green pass with nothing run.
 */
export default async function setup(): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Integration suite requires TEST_DATABASE_URL — running it without a DB silently skips every " +
        "test and reports false-green. Set TEST_DATABASE_URL to a Postgres you don't mind being migrated.",
    );
  }

  // 1. Apply the drizzle app migrations so the schema is always current (no stale-schema self-skip).
  const pool = new Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }

  // 2. Install the graphile_worker schema.
  const utils = await makeWorkerUtils({ connectionString });
  try {
    await utils.migrate();
  } finally {
    await utils.release();
  }
}
