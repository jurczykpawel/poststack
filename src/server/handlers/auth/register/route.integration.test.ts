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

function post(body: unknown) {
  return app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("register rate limits (real Postgres)", () => {
  it("does not spend the registration limit on requests rejected by validation", async () => {
    if (!TEST_DB) return;
    for (let i = 0; i < 6; i++) {
      const res = await post({ email: "typo@example.test", password: "short" });
      expect(res.status).toBe(422);
    }
    const res = await register("after-typos@example.test");
    expect(res.status).toBe(201);
  });

  it("names the rejected field in the 422 response", async () => {
    if (!TEST_DB) return;
    const res = await post({ password: "supersecret123" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.details).toEqual([{ path: "email", message: "Email is required" }]);
  });

  it("allows 5 registration attempts that pass validation, then answers 429", async () => {
    if (!TEST_DB) return;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await register("same@example.test")).status);
    // 1st creates the owner; 2nd–5th are refused by the instance (counted); 6th is rate limited.
    expect(statuses[0]).toBe(201);
    expect(statuses.slice(1, 5).every((s) => s !== 429 && s !== 422)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it("caps all requests to the endpoint with a looser flood limit", async () => {
    if (!TEST_DB) return;
    for (let i = 0; i < 60; i++) {
      const res = await post({ email: "not-an-email", password: "x" });
      expect(res.status).toBe(422);
    }
    const res = await post({ email: "not-an-email", password: "x" });
    expect(res.status).toBe(429);
    // The flood limit covers valid requests too.
    expect((await register("blocked@example.test")).status).toBe(429);
  });
});

describe("register form (real Postgres)", () => {
  function submitForm(body: Record<string, string>) {
    return app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", "hx-request": "true" },
      body: JSON.stringify(body),
    });
  }

  it("shows the field error and still lets the person register after several form mistakes", async () => {
    if (!TEST_DB) return;
    for (let i = 0; i < 6; i++) {
      const res = await submitForm({ name: "", email: "form@example.test", password: "short" });
      expect(await res.text()).toContain("Password must be at least 8 characters");
    }
    const res = await submitForm({ name: "", email: "form@example.test", password: "supersecret123" });
    expect(res.headers.get("hx-redirect")).toBe("/inbox");
  });
});
