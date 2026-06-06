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
