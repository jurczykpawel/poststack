import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let applyCapture: typeof import("./capture-apply").applyCapture;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "c0ffee09-0000-4000-8000-000000000e01";
const CH = "c0ffee09-0000-4000-8000-000000000e02";
const CONTACT = "c0ffee09-0000-4000-8000-000000000e03";
const CONV = "c0ffee09-0000-4000-8000-000000000e04";

async function run(field: "email" | "phone", text: string | null) {
  return db.transaction((tx) => applyCapture(tx, { workspaceId: WS, conversationId: CONV, contactId: CONTACT, field, text }));
}

async function contact() {
  return db.query.contacts.findFirst({ where: eq(s.contacts.id, CONTACT), columns: { email: true, phone: true } });
}

async function conv() {
  return db.query.conversations.findFirst({ where: eq(s.conversations.id, CONV), columns: { awaiting_capture: true } });
}

async function updatedEvents() {
  return db.select().from(s.events).where(and(eq(s.events.workspace_id, WS), eq(s.events.type, "contact.updated")));
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ applyCapture } = await import("./capture-apply"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { makeWorkerUtils } = await import("graphile-worker");
  const utils = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL! });
  await utils.migrate();
  await utils.release();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "T", slug: `t-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-LC", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open", awaiting_capture: "email" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await closeQueue();
});

describe.skipIf(!TEST_DB)("LEADCAP1 — applyCapture", () => {
  it("captures a valid email onto the contact, clears the flag, and emits contact.updated", async () => {
    const value = await run("email", "sure, it's Jan@Example.com");
    expect(value).toBe("jan@example.com");
    expect((await contact())?.email).toBe("jan@example.com");
    expect((await conv())?.awaiting_capture).toBeNull();
    expect(await updatedEvents()).toHaveLength(1);
  });

  it("captures a phone when armed for phone", async () => {
    await db.update(s.conversations).set({ awaiting_capture: "phone" }).where(eq(s.conversations.id, CONV));
    const value = await run("phone", "+48 501 761 834");
    expect(value).toBe("+48501761834");
    expect((await contact())?.phone).toBe("+48501761834");
    expect((await conv())?.awaiting_capture).toBeNull();
  });

  it("on junk text: clears the flag, stores nothing, emits no event (one-shot)", async () => {
    const value = await run("email", "no way");
    expect(value).toBeNull();
    expect((await contact())?.email).toBeNull();
    expect((await conv())?.awaiting_capture).toBeNull();
    expect(await updatedEvents()).toHaveLength(0);
  });
});
