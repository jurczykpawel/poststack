import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";

// Mock the queue boundary so we can inject a first-step enqueue failure; the DB is real.
const addJobTx = vi.fn(async () => {});
vi.mock("@/lib/queue/client", () => ({
  addJobTx,
  addJob: vi.fn(async () => {}),
  closeQueue: vi.fn(async () => {}),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_enroll_atomic_key_abcdef01";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let enroll: typeof import("./[sequenceId]/enroll/route");
let sequence: typeof import("./[sequenceId]/route");
let enrollmentCancel: typeof import("./[sequenceId]/enrollments/[enrollmentId]/route");

const WS = "eeeeeeee-0000-4000-8000-0000000000e1";
const CH = "eeeeeeee-0000-4000-8000-0000000000e2";
const CONTACT = "eeeeeeee-0000-4000-8000-0000000000e3";
let seqId: string;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  enroll = await import("./[sequenceId]/enroll/route");
  sequence = await import("./[sequenceId]/route");
  enrollmentCancel = await import("./[sequenceId]/enrollments/[enrollmentId]/route");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  addJobTx.mockReset();
  addJobTx.mockResolvedValue(undefined);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "EA", slug: `ea-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-EA", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-EA" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "sk_live_en" });
  const [seq] = await db.insert(s.sequences).values({
    workspace_id: WS, name: "Seq", status: "active", steps: [{ type: "message", content: "hi" }],
  }).returning({ id: s.sequences.id });
  seqId = seq.id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end?.();
});

const post = () => new Request("http://x", {
  method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ contact_id: CONTACT, channel_id: CH }),
});
const ctx = () => ({ params: Promise.resolve({ sequenceId: seqId }) });
const enrollmentExists = async () =>
  (await db.query.sequenceEnrollments.findFirst({ where: and(eq(s.sequenceEnrollments.sequence_id, seqId), eq(s.sequenceEnrollments.contact_id, CONTACT)) })) != null;

describe("enroll is atomic with the first-step enqueue", () => {
  it("leaves no orphan enrollment when the first-step enqueue fails, and a retry succeeds", async () => {
    if (!TEST_DB) return;
    addJobTx.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(enroll.POST(post(), ctx())).rejects.toThrow();
    // No active enrollment was left behind — otherwise the unique (sequence, contact) constraint
    // would make a retry impossible while no first step is queued.
    expect(await enrollmentExists()).toBe(false);

    // The retry now succeeds: enrollment created AND first step enqueued, with the pinned snapshot.
    const res = await enroll.POST(post(), ctx());
    expect(res.status).toBe(201);
    expect(await enrollmentExists()).toBe(true);
    const enr = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.sequence_id, seqId) });
    expect(enr?.steps_snapshot).toEqual([{ type: "message", content: "hi" }]);
    expect(addJobTx).toHaveBeenLastCalledWith(
      expect.anything(), "sequence-step", { enrollmentId: enr!.id }, expect.objectContaining({ jobKey: `seq-step:${enr!.id}:0` }),
    );
  });
});

const seedEnrollment = async () => {
  const [enr] = await db.insert(s.sequenceEnrollments).values({
    sequence_id: seqId, contact_id: CONTACT, channel_id: CH, status: "active", current_step_index: 0,
    steps_snapshot: [{ type: "message", content: "hi" }],
  }).returning({ id: s.sequenceEnrollments.id });
  return enr.id;
};
const authedReq = () => new Request("http://x", { method: "DELETE", headers: { authorization: `Bearer ${KEY}` } });

// an in-flight enrollment can be cancelled (the only prior "stop" was deleting the sequence).
describe("cancel enrollment", () => {
  it("flips an active enrollment to cancelled", async () => {
    if (!TEST_DB) return;
    const enrId = await seedEnrollment();
    const res = await enrollmentCancel.DELETE(authedReq(), { params: Promise.resolve({ sequenceId: seqId, enrollmentId: enrId }) });
    expect(res.status).toBe(200);
    const row = await db.query.sequenceEnrollments.findFirst({ where: eq(s.sequenceEnrollments.id, enrId) });
    expect(row?.status).toBe("cancelled");
  });
});

// deleting a sequence with active enrollments is blocked with a 409 (symmetric with
// channel-delete); once the enrollment is no longer active, the delete goes through.
describe("sequence DELETE guards active enrollments", () => {
  it("returns 409 with an active enrollment, 204 after it's cancelled", async () => {
    if (!TEST_DB) return;
    const enrId = await seedEnrollment();
    expect((await sequence.DELETE(authedReq(), ctx())).status).toBe(409);

    await db.update(s.sequenceEnrollments).set({ status: "cancelled" }).where(eq(s.sequenceEnrollments.id, enrId));
    expect((await sequence.DELETE(authedReq(), ctx())).status).toBe(204);
  });
});
