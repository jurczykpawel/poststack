import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import { eq } from "drizzle-orm";
import { workspaces, channels, contacts, contactChannels, conversations, messages, outboundDeliveries } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;

let pool: Pool;
let db: typeof import("@/lib/db").db;
let drainChannel: typeof import("./drain").drainChannel;
let DRAIN_BATCH_SIZE: number;
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
  ({ drainChannel, DRAIN_BATCH_SIZE } = await import("./drain"));
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
  await db.delete(outboundDeliveries).where(eq(outboundDeliveries.channel_id, CH));
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

/** Park a held delivery on the ledger, optionally with a linked inbox `held` message row. */
async function seedHeld(opts: {
  key: string;
  task: "outgoing-message" | "outgoing-comment" | "outgoing-private-reply" | "follow-gate";
  payload: Record<string, unknown>;
  withMessageRow?: boolean;
}): Promise<{ heldMessageId?: string }> {
  let heldMessageId: string | undefined;
  if (opts.withMessageRow) {
    const [m] = await db.insert(messages)
      .values({ conversation_id: CONV, direction: "outbound", text: "held", status: "held" })
      .returning({ id: messages.id });
    heldMessageId = m.id;
  }
  await db.insert(outboundDeliveries).values({
    delivery_key: opts.key, workspace_id: WS, channel_id: CH, task_name: opts.task,
    payload: { ...opts.payload, idempotencyKey: opts.key, ...(heldMessageId ? { heldMessageId } : {}) },
    status: "held", attempts: 1,
  });
  return { heldMessageId };
}

async function setAnchor(at: Date | null) {
  await db.update(conversations).set({ last_inbound_at: at }).where(eq(conversations.id, CONV));
}

const msgPayload = () => ({ channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: "PSID-1", content: { text: "hi" } });

describe("drainChannel (real Postgres) — park + drain end to end", () => {
  it("re-enqueues a held message inside the window and keeps the delivery held", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date(Date.now() - 60 * 60 * 1000)); // 1h ago
    const { heldMessageId } = await seedHeld({ key: "d-1", task: "outgoing-message", payload: msgPayload(), withMessageRow: true });

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: 1, expired: 0 });
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "d-1") }))?.status).toBe("held");
    expect((await db.query.messages.findFirst({ where: eq(messages.id, heldMessageId!) }))?.status).toBe("held");

    const jobs = await pool.query("select task_identifier, key from graphile_worker.jobs");
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].task_identifier).toBe("outgoing-message");
    expect(jobs.rows[0].key).toBe("drain:d-1");
  });

  it("expires a held message past the window and clears its inbox row", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date(Date.now() - 25 * 60 * 60 * 1000)); // 25h ago
    const { heldMessageId } = await seedHeld({ key: "d-stale", task: "outgoing-message", payload: msgPayload(), withMessageRow: true });

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: 0, expired: 1 });
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "d-stale") }))?.status).toBe("expired");
    expect((await db.query.messages.findFirst({ where: eq(messages.id, heldMessageId!) }))?.status).toBe("expired");
    const jobs = await pool.query("select count(*)::int as n from graphile_worker._private_jobs");
    expect(jobs.rows[0].n).toBe(0);
  });

  it("does nothing while the breaker is still open (channel not active)", async () => {
    if (!TEST_DB) return;
    await setAnchor(new Date());
    await seedHeld({ key: "d-down", task: "outgoing-message", payload: msgPayload() });
    await db.update(channels).set({ status: "needs_reauth" }).where(eq(channels.id, CH));

    const result = await drainChannel(CH);

    expect(result.skipped).toBe("needs_reauth");
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "d-down") }))?.status).toBe("held");
  });

  //  — the drain re-dispatches each parked operation as its ORIGINAL task type with its
  // ORIGINAL payload, so a comment is replayed as a comment (not flattened to a DM), a private
  // reply keeps its comment id, and a follow-gate re-runs the gate.
  it("re-dispatches a parked comment as outgoing-comment with its full payload", async () => {
    if (!TEST_DB) return;
    await seedHeld({ key: "d-cmt", task: "outgoing-comment", payload: { channelId: CH, commentId: "CMT-9", text: "ty!" } });

    const result = await drainChannel(CH);

    expect(result.enqueued).toBe(1);
    const jobs = await pool.query(
      "select task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id",
    );
    expect(jobs.rows[0].task_identifier).toBe("outgoing-comment");
    expect(jobs.rows[0].payload.commentId).toBe("CMT-9");
  });

  it("re-dispatches a parked private reply as outgoing-private-reply, preserving the comment id", async () => {
    if (!TEST_DB) return;
    await seedHeld({
      key: "d-pr", task: "outgoing-private-reply",
      payload: { channelId: CH, conversationId: CONV, commentId: "CMT-PR", text: "via DM" },
      withMessageRow: true,
    });

    const result = await drainChannel(CH);

    expect(result.enqueued).toBe(1);
    const jobs = await pool.query(
      "select task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id",
    );
    expect(jobs.rows[0].task_identifier).toBe("outgoing-private-reply");
    expect(jobs.rows[0].payload.commentId).toBe("CMT-PR");
  });

  it("re-dispatches a parked follow-gate as follow-gate", async () => {
    if (!TEST_DB) return;
    await seedHeld({
      key: "d-fg", task: "follow-gate",
      payload: { channelId: CH, conversationId: CONV, contactId: CONTACT, recipientPlatformId: "PSID-1", followed: { text: "guide" }, notFollowed: { text: "follow first" } },
    });

    const result = await drainChannel(CH);

    expect(result.enqueued).toBe(1);
    const jobs = await pool.query("select task_identifier from graphile_worker.jobs");
    expect(jobs.rows[0].task_identifier).toBe("follow-gate");
  });

  //  — a comment-triggered DM lives on a conversation with no inbound DM (last_inbound_at
  // NULL). It must not be expired the instant it drains: the window falls back to parked_at.
  it("does not expire an outgoing-message when last_inbound_at is NULL (within the parked window)", async () => {
    if (!TEST_DB) return;
    await setAnchor(null);
    await seedHeld({ key: "d-noinb", task: "outgoing-message", payload: msgPayload(), withMessageRow: true });

    const result = await drainChannel(CH); // parked just now → inside the 24h window
    expect(result).toEqual({ enqueued: 1, expired: 0 });
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "d-noinb") }))?.status).toBe("held");
  });

  it("expires an outgoing-message with NULL last_inbound_at once 24h past parked_at", async () => {
    if (!TEST_DB) return;
    await setAnchor(null);
    await seedHeld({ key: "d-noinb-old", task: "outgoing-message", payload: msgPayload(), withMessageRow: true });

    const result = await drainChannel(CH, new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(result).toEqual({ enqueued: 0, expired: 1 });
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(outboundDeliveries.delivery_key, "d-noinb-old") }))?.status).toBe("expired");
  });

  //  — a backlog larger than one page must be drained completely, in keyset batches, without
  // re-reading the rows it re-enqueues (which stay `held`) or skipping any.
  it("drains a backlog larger than one batch, accounting for every held row exactly once", async () => {
    if (!TEST_DB) return;
    const total = DRAIN_BATCH_SIZE + 25; // spills past one page → at least two rounds
    // outgoing-comment uses a parked_at / 7-day window, so all freshly-parked rows are in-window.
    await db.insert(outboundDeliveries).values(
      Array.from({ length: total }, (_, i) => ({
        delivery_key: `bulk-${i}`, workspace_id: WS, channel_id: CH, task_name: "outgoing-comment" as const,
        payload: { channelId: CH, commentId: `C-${i}`, text: "ty", idempotencyKey: `bulk-${i}` },
        status: "held" as const, attempts: 1,
      })),
    );

    const result = await drainChannel(CH);

    expect(result).toEqual({ enqueued: total, expired: 0 });
    const jobs = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-comment'");
    expect(jobs.rows[0].n).toBe(total);
  });
});
