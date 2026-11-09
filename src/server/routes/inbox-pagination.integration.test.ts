import { afterAll, beforeAll, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { Pool } from "pg";
import type { Hono } from "hono";

let app: Hono;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let pool: Pool;
let cookie: string;
const workspaceId = "65000000-0000-4000-8000-000000000001";
const userId = "65000000-0000-4000-8000-000000000002";
const channelId = "65000000-0000-4000-8000-000000000003";
const contactId = "65000000-0000-4000-8000-000000000004";
const ids = Array.from({ length: 55 }, (_, i) => `65000000-0000-4000-8000-${String(1000 - i).padStart(12, "0")}`);

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0".repeat(64);
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  // One real connection keeps each session setting in force for every route query.
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  (globalThis as typeof globalThis & { dbPool?: Pool }).dbPool = pool;
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  app = (await import("../app")).buildApp();
  cookie = `session=${await (await import("@/lib/auth")).signSession(userId, workspaceId)}`;
  await db.insert(schema.users).values({ id: userId, email: "pagination@example.test" });
  await db.insert(schema.workspaces).values({ id: workspaceId, name: "Pagination", slug: "pagination-zones" });
  await db.insert(schema.workspaceMembers).values({ workspace_id: workspaceId, user_id: userId, role: "owner" });
  await db.insert(schema.channels).values({ id: channelId, workspace_id: workspaceId, platform: "instagram", platform_id: "pagination-zones", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(schema.contacts).values({ id: contactId, workspace_id: workspaceId });
  await db.insert(schema.conversations).values(ids.map((id, i) => ({
    id, workspace_id: workspaceId, channel_id: channelId, contact_id: contactId,
    platform: "instagram" as const, thread_ref: id,
    // Equal timestamps straddle the 50-row boundary and UTC midnight.
    last_message_at: new Date(Date.UTC(2026, 0, 1) - Math.floor((i + 3) / 10) * 60_000),
  })));
});

afterAll(async () => {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await pool.end();
  delete (globalThis as typeof globalThis & { dbPool?: Pool }).dbPool;
});

it.each(["UTC", "Europe/Warsaw", "America/Los_Angeles"])("loads each older conversation once in a %s database session", async (zone) => {
  await db.execute(sql`select set_config('TimeZone', ${zone}, false)`);
  const rows = (html: string) => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
  const first = await (await app.request(`/inbox/list?channel=${channelId}`, { headers: { cookie } })).text();
  expect(rows(first)).toEqual(ids.slice(0, 50));
  const next = first.match(/hx-get="(\/inbox\/older\?[^"]+)"/);
  expect(next).not.toBeNull();
  const second = await (await app.request(`${next![1]!.replace(/&amp;/g, "&")}&channel=${channelId}`, { headers: { cookie } })).text();
  expect(rows(second)).toEqual(ids.slice(50));
  expect(second).not.toContain("conv-older");
  const restored = await (await app.request(`/inbox/list?channel=${channelId}&pages=2`, { headers: { cookie } })).text();
  expect(rows(restored)).toEqual(ids);
});
