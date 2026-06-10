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
  await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  await migrate(db, { migrationsFolder: "./drizzle" });
} finally {
  await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  lockClient.release();
}

await pool.end();
console.log("[migrate] database up to date");
