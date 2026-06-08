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
 * True for a Postgres unique-violation error (SQLSTATE 23505) — a conflicting row.
 * Drizzle wraps driver errors in a DrizzleQueryError, so the pg `code` can sit on
 * `.cause` rather than the top-level error; check both.
 */
export function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): string | undefined =>
    typeof e === "object" && e !== null && "code" in e ? (e as { code?: string }).code : undefined;
  return codeOf(err) === "23505" || codeOf((err as { cause?: unknown })?.cause) === "23505";
}
