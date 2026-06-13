import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let db: typeof import("@/lib/db").db;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  // Registration closed: only the very first account (empty instance) may register.
  delete process.env.REGISTRATION_ENABLED;

  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../../app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  // Bootstrap path triggers only on a truly empty instance.
  await pool.query("truncate table users, workspaces cascade");
  await pool.query("DELETE FROM rate_limit_counters");
});

afterAll(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table users, workspaces cascade");
  if (closeQueue) await closeQueue();
  await db.$client.end();
  await pool.end();
});

function register(email: string) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "supersecret123" }),
  });
}

describe("register bootstrap (real Postgres)", () => {
  it("lets exactly one account win when an empty instance is bootstrapped concurrently", async () => {
    if (!TEST_DB) return;
    // Two simultaneous first-account registrations on a closed-by-default instance.
    // Only one may become the owner; the second must be refused because the
    // instance is no longer empty.
    const [a, b] = await Promise.all([
      register("race-a@example.test"),
      register("race-b@example.test"),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 403]);

    const { rows } = await pool.query("select count(*)::int as n from users");
    expect(rows[0].n).toBe(1);
  });
});
