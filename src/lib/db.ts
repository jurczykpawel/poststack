import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import * as relations from "@/db/relations";

const globalForDb = globalThis as unknown as { dbPool?: Pool };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

/** Parse a non-negative numeric env override, falling back when unset/invalid. */
function envNum(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Pool resilience. Without these a stalled statement or an idle-in-transaction session
// pins its pooled connection indefinitely — under load the pool drains and every later query/job
// hangs. node-postgres applies statement_timeout / idle_in_transaction_session_timeout server-side
// per connection, so a query that overruns 30s (or a transaction left idle >60s, e.g. the DB
// pausing mid-tx) is cancelled and its connection returned to the pool instead of leaking. `max` is
// pinned explicitly so the connection budget is sized deliberately (see README → Production):
// (web + worker replicas) × DB_POOL_MAX + worker concurrency + listeners must stay under the
// server's max_connections. Each is overridable; 0 disables a timeout.
const pool =
  globalForDb.dbPool ??
  new Pool({
    connectionString,
    max: envNum(process.env.DB_POOL_MAX, 10),
    statement_timeout: envNum(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000),
    idle_in_transaction_session_timeout: envNum(process.env.DB_IDLE_TX_TIMEOUT_MS, 60_000),
  });
if (process.env.NODE_ENV !== "production") globalForDb.dbPool = pool;

export const db = drizzle(pool, { schema: { ...schema, ...relations } });

/**
 * Drizzle wraps driver errors in a DrizzleQueryError, so the pg SQLSTATE `code` can sit on
 * `.cause` rather than the top-level error; check both.
 */
function hasSqlState(err: unknown, code: string): boolean {
  const codeOf = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e ? (e as { code?: string }).code : undefined;
  return codeOf(err) === code || codeOf((err as { cause?: unknown })?.cause) === code;
}

/** True for a Postgres unique-violation error (SQLSTATE 23505) — a conflicting row. */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, "23505");
}

/**
 * True for a Postgres foreign-key-violation error (SQLSTATE 23503) — e.g. deleting a row
 * still referenced by an ON DELETE RESTRICT dependent. Lets handlers surface a clean 409
 * instead of an unhandled 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasSqlState(err, "23503");
}
