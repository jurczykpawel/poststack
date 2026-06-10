import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Arbitrary fixed key shared by every replica — the lock namespace is the whole DB, so a constant
// is all that's needed to make them queue on the same lock.
const MIGRATION_LOCK_KEY = 4815162342;

const pool = new Pool({ connectionString });
const db = drizzle(pool);

// Serialize concurrent startup migrations across web replicas with a session advisory lock.
// The entrypoint runs this on EVERY replica before serving, and the baseline has non-idempotent
// CREATE TYPE statements — so a `--scale web=N` first boot / migration-bearing upgrade would have
// every replica race the same DDL, all but one aborting on "already exists" and crash-looping under
// `restart: always`. The first replica to grab the lock migrates; the rest block here, then see an
// already-migrated DB and skip. The lock is held on one dedicated session and released in `finally`;
// if the process dies mid-migrate the session ends and Postgres frees it automatically.
const lockClient = await pool.connect();
try {
  // Bound the lock wait: without lock_timeout a replica whose lock-holder hangs mid-migration
  // would block on pg_advisory_lock forever — a silent, churn-free hang of the whole web tier (worse
  // than the earlier crash-loop, which `restart: always` at least made visible). With it, a waiter
  // errors after 30s → the entrypoint exits non-zero → restart loop, i.e. the old VISIBLE behaviour,
  // while keeping the serialization. statement_timeout is a backstop on the lock call itself.
  await lockClient.query("SET lock_timeout = '30s'");
  await lockClient.query("SET statement_timeout = '60s'");
  await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  await migrate(db, { migrationsFolder: "./drizzle" });
} finally {
  // Best-effort: if the lock was never acquired (timed out) this is a harmless no-op.
  await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
  lockClient.release();
}

await pool.end();
console.log("[migrate] database up to date");
