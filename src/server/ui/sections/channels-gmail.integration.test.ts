import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

// Verify the Connect Gmail button and filter panel render correctly.

vi.mock("@/lib/queue/client", () => ({
  addJob: vi.fn(async () => {}),
  addJobTx: vi.fn(async () => {}),
  closeQueue: async () => {},
}));

import { vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "ff110000-0000-0000-0000-0000000000f1";
const USER = "ff110000-0000-0000-0000-0000000000f2";
const CH_GMAIL = "ff110000-0000-0000-0000-0000000000f3";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("@/server/app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-gmail-ui-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "Gmail UI WS", slug: `gmail-ui-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.$client.end?.();
});

describe("channels page — Gmail connect affordance", () => {
  it("shows Gmail in the connect section (PRO-locked on free tier)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/channels", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // On a free instance Gmail is PRO-locked but still visible.
    expect(body).toContain("Gmail");
  });
});

describe("channel detail page — Gmail filter panel", () => {
  it("shows the ingest filter input for a Gmail channel", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      id: CH_GMAIL, workspace_id: WS, platform: "gmail", platform_id: "user@gmail.com",
      token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth",
      gmail_query: "label:Support",
    });
    const res = await app.request(`/channels/${CH_GMAIL}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("gmail-filter-panel");
    expect(body).toContain('name="query"');
    expect(body).toContain("label:Support");
  });

  it("shows an empty filter input when gmail_query is null", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      id: CH_GMAIL, workspace_id: WS, platform: "gmail", platform_id: "user@gmail.com",
      token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth",
    });
    const res = await app.request(`/channels/${CH_GMAIL}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("gmail-filter-panel");
    expect(body).toContain('name="query"');
  });
});
