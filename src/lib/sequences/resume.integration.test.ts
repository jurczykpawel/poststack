import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runMigrations } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let resumeDueEnrollments: typeof import("./resume").resumeDueEnrollments;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "dddddddd-0000-4000-8000-0000000000b1";
const CH = "dddddddd-0000-4000-8000-0000000000b2";
const CONTACT = "dddddddd-0000-4000-8000-0000000000b3";
let seqId: string;

const HOUR = 3_600_000;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ resumeDueEnrollments } = await import("./resume"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "R", slug: `resume-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-RS", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  const [seq] = await db.insert(s.sequences).values({ workspace_id: WS, name: "Seq", status: "active", steps: [{ type: "message", content: "hi" }] }).returning({ id: s.sequences.id });
  seqId = seq.id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
  await db.$client.end?.();
});

async function seedEnrollment(over: Record<string, unknown>) {
  const [enr] = await db.insert(s.sequenceEnrollments)
    .values({ sequence_id: seqId, contact_id: CONTACT, channel_id: CH, current_step_index: 0, steps_snapshot: [{ type: "message", content: "hi" }], ...over })
    .returning({ id: s.sequenceEnrollments.id });
  return enr.id;
}
async function resumeJobKeys(): Promise<string[]> {
  const r = await db.execute(sql`select key from graphile_worker.jobs where task_identifier = 'sequence-step'`);
  return (r.rows as Array<{ key: string }>).map((row) => row.key);
}

//  — un-pause resumes only enrollments whose step is already DUE (deferred by the pause),
// never one that's merely scheduled for the future (which would process it early).
describe("resumeDueEnrollments", () => {
  it("enqueues an immediate sequence-step for a due active enrollment", async () => {
    if (!TEST_DB) return;
    const id = await seedEnrollment({ status: "active", next_step_at: new Date(Date.now() - HOUR) });
    await db.transaction((tx) => resumeDueEnrollments(tx, { channelId: CH }));
    expect(await resumeJobKeys()).toEqual([`seq-resume:${id}`]);
  });

  it("does NOT enqueue a not-yet-due active enrollment (avoids processing it early)", async () => {
    if (!TEST_DB) return;
    await seedEnrollment({ status: "active", next_step_at: new Date(Date.now() + HOUR) });
    await db.transaction((tx) => resumeDueEnrollments(tx, { channelId: CH }));
    expect(await resumeJobKeys()).toEqual([]);
  });

  it("does NOT enqueue a non-active enrollment", async () => {
    if (!TEST_DB) return;
    await seedEnrollment({ status: "cancelled", next_step_at: new Date(Date.now() - HOUR) });
    await db.transaction((tx) => resumeDueEnrollments(tx, { channelId: CH }));
    expect(await resumeJobKeys()).toEqual([]);
  });
});
