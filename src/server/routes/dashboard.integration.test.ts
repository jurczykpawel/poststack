import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "dddddddd-0000-0000-0000-0000000000a1";
const USER = "dddddddd-0000-0000-0000-0000000000a2";
const CH = "dddddddd-0000-0000-0000-0000000000a3";
const CONTACT = "dddddddd-0000-0000-0000-0000000000a4";
const CONV = "dddddddd-0000-0000-0000-0000000000a5";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `rs_session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-D", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-D" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function reply(text: string) {
  return app.request(`/inbox/${CONV}/reply`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function setRetention(value: unknown) {
  return app.request("/settings/retention", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message_retention_days: value }),
  });
}

async function retentionDays(): Promise<number | null> {
  const [w] = await db.select().from(s.workspaces).where(eq(s.workspaces.id, WS));
  return w.message_retention_days;
}

describe("dashboard /inbox/:id/reply — surfaces send failures", () => {
  it("shows an error notice and keeps the draft when the send is rejected", async () => {
    if (!TEST_DB) return;
    const draft = "x".repeat(2500); // over the 2000-char limit → validation error
    const res = await reply(draft);
    const body = await res.text();
    expect(body).toContain("notice-err");
    // The typed message must NOT be silently discarded.
    expect(body).toContain(draft);
  });

  it("re-renders the thread with no error notice when the reply is accepted", async () => {
    if (!TEST_DB) return;
    const res = await reply("thanks!");
    const body = await res.text();
    expect(body).not.toContain("notice-err");
  });
});

describe("dashboard /settings/retention — validates days", () => {
  it.each([0, -5, 1.5])("rejects %s and leaves the policy unchanged", async (bad) => {
    if (!TEST_DB) return;
    const res = await setRetention(bad);
    const body = await res.text();
    expect(body).not.toContain("Saved.");
    expect(await retentionDays()).toBeNull();
  });

  it("accepts a positive whole number of days", async () => {
    if (!TEST_DB) return;
    const res = await setRetention(30);
    const body = await res.text();
    expect(body).toContain("Saved.");
    expect(await retentionDays()).toBe(30);
  });
});
