import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import { eq } from "drizzle-orm";
import { users, workspaces, channels } from "@/db/schema";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "special-smoke-app-secret";
const EMAIL = "hono-special@example.test";
const PASSWORD = "supersecret123";
const PAGE = "PAGE-SPECIAL";

let pool: Pool;
let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;

const WS = "cccccccc-0000-0000-0000-000000000001";
const CH = "cccccccc-0000-0000-0000-000000000002";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify";

  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Smoke", slug: `sp-${WS}` });
  await db.insert(channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE,
    token_encrypted: encryptTokens({ access_token: "tok" }), webhook_secret: "wh", status: "active",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  // Leave the shared graphile queue clean for serially-following suites.
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  if (closeQueue) await closeQueue();
  await db.$client.end();
  await pool.end();
});

describe("auth flow under Hono (real Postgres)", () => {
  it("register issues a session cookie", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/rs_session=[^;]+/);
    expect(setCookie).not.toMatch(/rs_session=;/);
  });

  it("does not reveal whether an email is already registered", async () => {
    if (!TEST_DB) return;
    await pool.query("DELETE FROM rate_limit_counters");
    const first = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const body = (await second.text()).toLowerCase();
    expect(body).not.toContain("already exists");
    expect(body).not.toContain("email");
  });

  it("register accepts an empty name field (the json-enc form always sends name)", async () => {
    if (!TEST_DB) return;
    // The register form posts via htmx json-enc, which serializes every field,
    // so a blank optional name arrives as "" — it must be treated as absent.
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "" }),
    });
    expect(res.status).toBe(201);
  });

  it("login with correct credentials issues a session cookie", async () => {
    if (!TEST_DB) return;
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/rs_session=[^;]+/);
  });

  it("login with a wrong password is rejected (401)", async () => {
    if (!TEST_DB) return;
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrongpassword" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("webhook ingest under Hono (real Postgres)", () => {
  it("accepts a signed DM webhook and enqueues an incoming-message job", async () => {
    if (!TEST_DB) return;
    const body = JSON.stringify({
      object: "page",
      entry: [
        {
          id: PAGE,
          messaging: [
            {
              sender: { id: "PSID-SP" },
              recipient: { id: PAGE },
              timestamp: 1_770_000_000_000,
              message: { mid: "mid-special", text: "hi" },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
    const res = await app.request("/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);

    const job = await pool.query(
      "select task_identifier from graphile_worker.jobs where key = $1",
      ["msg-mid-special"],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].task_identifier).toBe("incoming-message");
  });
});
