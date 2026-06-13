import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import type { Hono } from "hono";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

// Multitenancy gate: a free (unlicensed) instance is single-tenant — the 2nd+
// registration is refused with 402 PRO_REQUIRED. A pro license unlocks it.
const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let db: typeof import("@/lib/db").db;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let gate: typeof import("@/lib/license/gate");
let app: Hono;
let key: TestKey;

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  // Multiple users may register; the multitenancy gate (not the closed-default
  // gate) is what must enforce single-tenancy on a free instance.
  process.env.REGISTRATION_ENABLED = "true";

  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  gate = await import("@/lib/license/gate");
  const { buildApp } = await import("../../../app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table users, workspaces cascade");
  await pool.query("DELETE FROM rate_limit_counters");
  await pool.query("truncate table instance_license");
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table users, workspaces cascade");
  await pool.query("truncate table instance_license");
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

describe("multitenancy gate on registration (real Postgres)", () => {
  it("free instance: first account succeeds, second is refused with 402", async () => {
    if (!TEST_DB) return;
    const first = await register("owner@example.test");
    expect(first.status).toBe(201);

    const second = await register("second@example.test");
    expect(second.status).toBe(402);
    const body = await second.json();
    expect(body.error.code).toBe("PRO_REQUIRED");
    expect(body.error.details.feature).toBe("multi_workspace");

    const { rows } = await pool.query("select count(*)::int as n from workspaces");
    expect(rows[0].n).toBe(1); // no second workspace was created
  });

  it("a pro license does NOT unlock multitenancy (owner-only business feature)", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    const res = await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    expect(res.state.features.has("multi_workspace")).toBe(false);

    expect((await register("owner@example.test")).status).toBe(201);
    expect((await register("second@example.test")).status).toBe(402);
  });

  it("licensed (business) instance: a second account is allowed", async () => {
    if (!TEST_DB) return;
    // Warm the gate with a valid business token (process-global cache, no network in handler).
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "business" }));
    const res = await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    expect(res.state.features.has("multi_workspace")).toBe(true);

    expect((await register("owner@example.test")).status).toBe(201);
    expect((await register("second@example.test")).status).toBe(201);

    const { rows } = await pool.query("select count(*)::int as n from workspaces");
    expect(rows[0].n).toBe(2);
  });
});
