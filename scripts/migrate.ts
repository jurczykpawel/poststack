import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("[migrate] database up to date");
