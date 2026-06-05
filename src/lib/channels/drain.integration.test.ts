import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let prisma: typeof import("@/lib/prisma").prisma;
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
  ({ prisma } = await import("@/lib/prisma"));
  ({ drainChannel } = await import("./drain"));
  ({ closeQueue } = await import("@/lib/queue/client"));

  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: "Drain Test", slug: `drain-${WS}` } });
  await prisma.channel.create({
    data: {
      id: CH, workspace_id: WS, platform: "instagram", platform_id: "PG-1",
      token_encrypted: "enc", webhook_secret: "secret", status: "active",
    },
  });
  await prisma.contact.create({ data: { id: CONTACT, workspace_id: WS } });
  await prisma.contactChannel.create({
    data: { contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-1" },
  });
  await prisma.conversation.create({
    data: { id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "instagram" },
  });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await prisma.message.deleteMany({ where: { conversation_id: CONV } });
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await prisma.channel.update({ where: { id: CH }, data: { status: "active" } });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  if (closeQueue) await closeQueue();
  if (prisma) await prisma.$disconnect();
  if (pool) await pool.end();
});

async function seedHeld(text: string): Promise<string> {
  const m = await prisma.message.create({
    data: { conversation_id: CONV, direction: "outbound", text, status: "held" },
  });
  return m.id;
}

async function setAnchor(at: Date | null) {
  await prisma.conversation.update({ where: { id: CONV }, data: { last_inbound_at: at } });
}

describe("drainChannel (real Postgres) — park + drain end to end", () => {
  it("re-enqueues a held message inside the window and keeps the row held", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    const id = await seedHeld("inside window");

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: 1, expired: 0 });
    const row = await prisma.message.findUnique({ where: { id } });
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
    const row = await prisma.message.findUnique({ where: { id } });
    expect(row?.status).toBe("expired");
    const jobs = await pool.query("select count(*)::int as n from graphile_worker._private_jobs");
    expect(jobs.rows[0].n).toBe(0);
  });

  it("does nothing while the breaker is still open (channel not active)", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date());
    const id = await seedHeld("still down");
    await prisma.channel.update({ where: { id: CH }, data: { status: "needs_reauth" } });

    const result = await drainChannel(CH);

    expect(result.skipped).toBe("needs_reauth");
    const row = await prisma.message.findUnique({ where: { id } });
    expect(row?.status).toBe("held");
  });
});
