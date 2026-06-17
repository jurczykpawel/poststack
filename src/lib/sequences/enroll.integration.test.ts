import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let enrollContactInSequence: typeof import("./enroll").enrollContactInSequence;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "dddddddd-0000-4000-8000-0000000000c1";
const CH = "dddddddd-0000-4000-8000-0000000000c2";
const CONTACT = "dddddddd-0000-4000-8000-0000000000c3";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ enrollContactInSequence } = await import("./enroll"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "E", slug: `enroll-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-EN", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
  await db.$client.end?.();
});

async function seedSequence(steps: unknown[]) {
  const [seq] = await db.insert(s.sequences).values({ workspace_id: WS, name: "Seq", status: "active", steps }).returning({ id: s.sequences.id, steps: s.sequences.steps });
  return seq;
}
async function stepJob(): Promise<{ key: string; run_at: string } | undefined> {
  const r = await db.execute(sql`select key, run_at from graphile_worker.jobs where task_identifier = 'sequence-step'`);
  return (r.rows as Array<{ key: string; run_at: string }>)[0];
}

describe("enrollContactInSequence (real Postgres)", () => {
  it("creates an enrollment, snapshots the steps, and schedules the first step now", async () => {
    if (!TEST_DB) return;
    const seq = await seedSequence([{ type: "message", content: "hi" }]);
    const res = await db.transaction((tx) => enrollContactInSequence(tx, { sequence: seq, contactId: CONTACT, channelId: CH }));
    expect(res.enrolled).toBe(true);
    const enr = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, res.enrollmentId!) });
    expect(enr?.status).toBe("active");
    expect(enr?.current_step_index).toBe(0);
    expect(enr?.steps_snapshot).toEqual([{ type: "message", content: "hi" }]);
    const job = await stepJob();
    expect(job?.key).toBe(`seq-step:${res.enrollmentId}:0`);
  });

  it("defers the first step by a leading delay step's minutes", async () => {
    if (!TEST_DB) return;
    const now = new Date("2026-06-17T10:00:00.000Z");
    const seq = await seedSequence([{ type: "delay", delay_minutes: 30 }, { type: "message", content: "later" }]);
    const res = await db.transaction((tx) => enrollContactInSequence(tx, { sequence: seq, contactId: CONTACT, channelId: CH, now }));
    expect(res.enrolled).toBe(true);
    const enr = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, res.enrollmentId!) });
    expect(enr?.next_step_at?.toISOString()).toBe("2026-06-17T10:30:00.000Z");
    const job = await stepJob();
    expect(new Date(job!.run_at).toISOString()).toBe("2026-06-17T10:30:00.000Z");
  });

  it("is idempotent — a second enroll of the same contact does not duplicate or reschedule", async () => {
    if (!TEST_DB) return;
    const seq = await seedSequence([{ type: "message", content: "hi" }]);
    const first = await db.transaction((tx) => enrollContactInSequence(tx, { sequence: seq, contactId: CONTACT, channelId: CH }));
    expect(first.enrolled).toBe(true);
    await db.execute(sql`truncate table graphile_worker._private_jobs cascade`); // clear the first step job

    const second = await db.transaction((tx) => enrollContactInSequence(tx, { sequence: seq, contactId: CONTACT, channelId: CH }));
    expect(second.enrolled).toBe(false);
    expect(second.enrollmentId).toBeUndefined();
    const count = await db.execute(sql`select count(*)::int as n from sequence_enrollments where sequence_id = ${seq.id}`);
    expect(Number((count.rows[0] as { n: number }).n)).toBe(1);
    expect(await stepJob()).toBeUndefined(); // no new step scheduled for the already-enrolled contact
  });
});
