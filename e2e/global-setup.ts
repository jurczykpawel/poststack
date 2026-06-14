import { execFileSync } from "child_process";
import { Client } from "pg";
import { E2E_DATABASE_URL, E2E_ADMIN_DATABASE_URL, serverEnv } from "./env";

// Runs ONCE before the web server boots. Creates the dedicated e2e database if missing, applies the
// Drizzle baseline (drizzle/0000_init.sql via scripts/migrate.ts) and the graphile-worker schema,
// then resets every table so each full run is deterministic. The admin registration + row seeding
// happen in auth.setup.ts (after the server is up), since registration bootstraps the workspace.
async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: E2E_ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'unify_e2e'");
    if (rows.length === 0) {
      await admin.query("CREATE DATABASE unify_e2e");
      console.log("[e2e] created database unify_e2e");
    }
  } finally {
    await admin.end();
  }
}

function applySchema(): void {
  const env = { ...serverEnv(), DATABASE_URL: E2E_DATABASE_URL };
  // Drizzle baseline (CREATE TYPE/TABLE …) — idempotent via the migrations journal.
  execFileSync("bun", ["scripts/migrate.ts"], { env, stdio: "inherit" });
  // graphile-worker schema (so the queue client never errors if a UI action touches it).
  execFileSync(
    "npx",
    ["graphile-worker", "-c", E2E_DATABASE_URL, "--schema-only"],
    { env, stdio: "inherit" },
  );
}

async function resetData(): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    // Truncate every app table (skip the migrations + graphile schemas) so a re-run starts clean.
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%'",
    );
    if (rows.length) {
      const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
      await client.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    }
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase();
  applySchema();
  await resetData();
}
