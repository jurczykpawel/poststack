import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import { eq } from "drizzle-orm";
import { workspaces, channels, contacts, contactChannels, conversations, messages } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let db: typeof import("@/lib/db").db;
let drainChannel: typeof import("./drain").drainChannel;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "aaaaaaaa-0000-0000-0000-000000000001";
const CH = "aaaaaaaa-0000-0000-0000-000000000002";
const CONTACT = "aaaaaaaa-0000-0000-0000-000000000003";
const CONV = "aaaaaaaa-0000-0000-0000-000000000004";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  ({ drainChannel } = await import("./drain"));
  ({ closeQueue } = await import("@/lib/queue/client"));

  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Drain Test", slug: `drain-${WS}` });
  await db.insert(channels).values({
    id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-1",
    token_encrypted: "enc", webhook_secret: "secret", status: "active",
  });
  await db.insert(contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-1" });
  await db.insert(conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram" });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(messages).where(eq(messages.conversation_id, CONV));
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await db.update(channels).set({ status: "active" }).where(eq(channels.id, CH));
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  if (closeQueue) await closeQueue();
  if (db) await db.$client.end();
  if (pool) await pool.end();
});

async function seedHeld(text: string): Promise<string> {
  const [m] = await db.insert(messages)
    .values({ conversation_id: CONV, direction: "outbound", text, status: "held" })
    .returning({ id: messages.id });
  return m.id;
}

async function setAnchor(at: Date | null) {
  await db.update(conversations).set({ last_inbound_at: at }).where(eq(conversations.id, CONV));
}

describe("drainChannel (real Postgres) — park + drain end to end", () => {
  it("re-enqueues a held message inside the window and keeps the row held", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    const id = await seedHeld("inside window");

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: 1, expired: 0 });
    const row = await db.query.messages.findFirst({ where: eq(messages.id, id) });
    expect(row?.status).toBe("held");

    const jobs = await pool.query(
      "select task_identifier, key from graphile_worker.jobs",
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].task_identifier).toBe("outgoing-message");
    expect(jobs.rows[0].key).toBe(`drain-msg:${id}`);
  });

  it("expires a held message past the window without enqueuing a send", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago
    const id = await seedHeld("stale");

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: 0, expired: 1 });
    const row = await db.query.messages.findFirst({ where: eq(messages.id, id) });
    expect(row?.status).toBe("expired");
    const jobs = await pool.query("select count(*)::int as n from graphile_worker._private_jobs");
    expect(jobs.rows[0].n).toBe(0);
  });

  it("does nothing while the breaker is still open (channel not active)", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date());
    const id = await seedHeld("still down");
    await db.update(channels).set({ status: "needs_reauth" }).where(eq(channels.id, CH));

    const result = await drainChannel(CH);

    expect(result.skipped).toBe("needs_reauth");
    const row = await db.query.messages.findFirst({ where: eq(messages.id, id) });
    expect(row?.status).toBe("held");
  });
});
