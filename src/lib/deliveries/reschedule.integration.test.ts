import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { runOnce, run, type JobHelpers } from "graphile-worker";

const publish = vi.fn(async () => ({ providerHandle: "published" }));
vi.mock("@/lib/providers", async (original) => ({
  ...await original<typeof import("@/lib/providers")>(),
  getProviderForPlatform: () => ({ requiresTokenRefresh: () => false, publish }),
  subKindForPlatform: () => "facebook_page",
}));
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let svc: typeof import("./service");
let contentSvc: typeof import("@/lib/content/service");
let processPublish: typeof import("./publish-worker").processPublish;
let addJobTx: typeof import("@/lib/queue/client").addJobTx;
let ws: string;
let other: string;
let channel: string;
let secondChannel: string;
let contentId: string;
const future = () => new Date(Date.now() + 3600_000).toISOString();

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  svc = await import("./service");
  contentSvc = await import("@/lib/content/service");
  ({ processPublish } = await import("./publish-worker"));
  ({ addJobTx } = await import("@/lib/queue/client"));
  const { seedWorkspace } = await import("../../../tests/helpers/workspace");
  ws = await seedWorkspace(db, s, { slug: `reschedule-${Date.now()}` });
  other = await seedWorkspace(db, s, { slug: `reschedule-other-${Date.now()}` });
  const { encryptTokens } = await import("@/lib/crypto");
  [channel, secondChannel] = (await db.insert(s.channels).values(["first", "second"].map((key) => ({
    workspace_id: ws, platform: "facebook" as const, platform_id: `reschedule-${key}`, status: "active" as const,
    token_encrypted: encryptTokens({ access_token: "fake" }), webhook_secret: "fake",
  }))).returning()).map((c) => c.id);
  contentId = (await contentSvc.createContent({ title: "Plan" }, ws)).id;
});
beforeEach(async () => {
  publish.mockClear();
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  await db.delete(s.posts).where(eq(s.posts.workspace_id, ws));
  await db.delete(s.deliveries).where(eq(s.deliveries.workspace_id, ws));
});
afterAll(async () => {
  if (ws) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  if (other) await db.delete(s.workspaces).where(eq(s.workspaces.id, other));
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  await db.$client.end();
});

async function seed(status: typeof s.deliveries.$inferSelect.status = "scheduled", when = new Date(), channelId = channel) {
  const payload = { format: "text", media: [], caption: "Keep these options", options: { privacyLevel: "SELF_ONLY", disableComment: true, consent: true } };
  const [d] = await db.insert(s.deliveries).values({ workspace_id: ws, channel_id: channelId, format: "text", status, payload, scheduled_at: when, run_at: when }).returning();
  const post = await contentSvc.createPost({ platform: "facebook", contentId, scheduledDate: when.toISOString() }, ws);
  await db.update(s.posts).set({ delivery_id: d!.id }).where(eq(s.posts.id, post.id));
  await addJobTx(db, "publish", { postId: d!.id }, { runAt: when, jobKey: `publish:${d!.id}` });
  return { d: d!, p: post };
}
async function job(id: string) {
  const result = await db.execute(sql`select * from graphile_worker.jobs where key = ${`publish:${id}`}`);
  return result.rows;
}

describe("reschedule", () => {
  it.each(["scheduled", "held"] as const)("moves %s delivery, linked date and actual job together without changing publish options", async (status) => {
    const { d, p } = await seed(status);
    const at = future();
    const changed = await svc.rescheduleDelivery(d.id, ws, at);
    expect(changed.status).toBe("scheduled");
    expect(changed.scheduled_at.toISOString()).toBe(at);
    expect(changed.run_at?.toISOString()).toBe(at);
    expect(changed.payload).toEqual(d.payload);
    expect((await contentSvc.getPost(p.id, ws))!.scheduled_date?.toISOString()).toBe(at);
    const jobs = await job(d.id);
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].run_at as string).toISOString()).toBe(at);
  });
  it.each(["sent", "canceled", "sending", "failed", "unknown"] as const)("returns 409 for %s and leaves its job/date unchanged", async (status) => {
    const { d } = await seed(status);
    await expect(svc.rescheduleDelivery(d.id, ws, future())).rejects.toMatchObject({ status: 409 });
    expect((await svc.getDelivery(d.id, ws))!.scheduled_at).toEqual(d.scheduled_at);
  });
  it("returns 404 in another workspace", async () => {
    const { d } = await seed();
    await expect(svc.rescheduleDelivery(d.id, other, future())).rejects.toMatchObject({ status: 404 });
  });
  it("PATCH scheduledDate moves the job; empty or terminal deliveries cannot diverge", async () => {
    const { d, p } = await seed();
    const at = future();
    await contentSvc.patchPost(p.id, ws, { scheduledDate: at });
    expect((await svc.getDelivery(d.id, ws))!.scheduled_at.toISOString()).toBe(at);
    expect(new Date((await job(d.id))[0].run_at as string).toISOString()).toBe(at);
    await expect(contentSvc.patchPost(p.id, ws, { scheduledDate: "" })).rejects.toMatchObject({ status: 409 });
    await db.update(s.deliveries).set({ status: "sending" }).where(eq(s.deliveries.id, d.id));
    await expect(contentSvc.patchPost(p.id, ws, { scheduledDate: future() })).rejects.toMatchObject({ status: 409 });
    expect((await contentSvc.getPost(p.id, ws))!.scheduled_date?.toISOString()).toBe(at);
  });
  it("Content moves all channels atomically and rolls back if any delivery is no longer pending", async () => {
    const a = await seed();
    const b = await seed("held", new Date(), secondChannel);
    const at = future();
    await contentSvc.rescheduleContent(contentId, ws, at);
    for (const { d, p } of [a, b]) {
      expect((await svc.getDelivery(d.id, ws))!.scheduled_at.toISOString()).toBe(at);
      expect((await contentSvc.getPost(p.id, ws))!.scheduled_date?.toISOString()).toBe(at);
    }
    await db.update(s.deliveries).set({ status: "sent" }).where(eq(s.deliveries.id, b.d.id));
    await expect(contentSvc.rescheduleContent(contentId, ws, new Date(Date.now() + 7200_000).toISOString())).rejects.toMatchObject({ status: 409 });
    expect((await svc.getDelivery(a.d.id, ws))!.scheduled_at.toISOString()).toBe(at);
    expect(new Date((await job(a.d.id))[0].run_at as string).toISOString()).toBe(at);
  });
  it("rejects invalid dates without changing either ledger", async () => {
    const { d, p } = await seed();
    for (const value of ["bad", new Date(Date.now() - 3600_000).toISOString()]) {
      await expect(svc.rescheduleDelivery(d.id, ws, value)).rejects.toMatchObject({ status: 422 });
      await expect(contentSvc.patchPost(p.id, ws, { scheduledDate: value })).rejects.toMatchObject({ status: 422 });
    }
    expect((await svc.getDelivery(d.id, ws))!.scheduled_at).toEqual(d.scheduled_at);
    expect((await contentSvc.getPost(p.id, ws))!.scheduled_date).toEqual(p.scheduled_date);
  });
  it("rolls back dates and the graphile replacement when the surrounding transaction rolls back", async () => {
    const { d, p } = await seed();
    await expect(db.transaction(async (tx) => {
      await svc.rescheduleDelivery(d.id, ws, future(), tx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await svc.getDelivery(d.id, ws))!.scheduled_at).toEqual(d.scheduled_at);
    expect((await contentSvc.getPost(p.id, ws))!.scheduled_date).toEqual(p.scheduled_date);
    expect(new Date((await job(d.id))[0].run_at as string)).toEqual(d.run_at);
  });
  it("the real runner cannot execute an unlocked job at the former time", async () => {
    const { d } = await seed();
    await svc.rescheduleDelivery(d.id, ws, future());
    const task = vi.fn();
    await runOnce({ connectionString: process.env.TEST_DATABASE_URL!, taskList: { publish: task } });
    expect(task).not.toHaveBeenCalled();
    expect(await job(d.id)).toHaveLength(1);
  });
  it("returns 409 once the runner has begun publishing", async () => {
    const { d } = await seed();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    publish.mockImplementationOnce(async () => { await gate; return { providerHandle: "published" }; });
    const runner = await run({ connectionString: process.env.TEST_DATABASE_URL!, pollInterval: 50, concurrency: 1, taskList: { publish: (payload, helpers) => processPublish(payload as { postId: string }, helpers) } });
    try {
      await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
      await expect(svc.rescheduleDelivery(d.id, ws, future())).rejects.toMatchObject({ status: 409 });
    } finally { unblock(); await runner.stop(); }
    expect(publish).toHaveBeenCalledOnce();
  });
  it("a job already fetched by the runner cannot publish after rescheduling", async () => {
    const { d } = await seed();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    const task = vi.fn(async (payload: unknown, helpers: JobHelpers) => {
      await gate;
      await processPublish(payload as { postId: string }, helpers);
    });
    const runner = await run({ connectionString: process.env.TEST_DATABASE_URL!, pollInterval: 50, concurrency: 1, taskList: { publish: task } });
    try {
      await vi.waitFor(() => expect(task).toHaveBeenCalledOnce());
      await svc.rescheduleDelivery(d.id, ws, future());
      unblock();
      await vi.waitFor(() => expect(task).toHaveResolvedTimes(1));
      expect(publish).not.toHaveBeenCalled();
      expect((await svc.getDelivery(d.id, ws))!.status).toBe("scheduled");
      expect(await job(d.id)).toHaveLength(1);
    } finally { unblock(); await runner.stop(); }
  });
});
