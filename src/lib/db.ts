import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import * as relations from "@/db/relations";

const globalForDb = globalThis as unknown as { dbPool?: Pool };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const pool = globalForDb.dbPool ?? new Pool({ connectionString });
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
