import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "rs_live_rules_seq_key_abcdef0123456789";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let rules: typeof import("./rules/route");
let rule: typeof import("./rules/[ruleId]/route");
let seqs: typeof import("./sequences/route");
let seq: typeof import("./sequences/[sequenceId]/route");
let enroll: typeof import("./sequences/[sequenceId]/enroll/route");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-4000-8000-0000000000c8";
const CH = "eeeeeeee-0000-4000-8000-0000000000c9";
const CONTACT = "eeeeeeee-0000-4000-8000-0000000000ca";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  rules = await import("./rules/route");
  rule = await import("./rules/[ruleId]/route");
  seqs = await import("./sequences/route");
  seq = await import("./sequences/[sequenceId]/route");
  enroll = await import("./sequences/[sequenceId]/enroll/route");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "RS", slug: `rs-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-RS", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-RS" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "rs_live_rs" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.sequenceEnrollments).where(eq(s.sequenceEnrollments.channel_id, CH));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = () => new Request("http://x", { headers: { authorization: `Bearer ${KEY}` } });

describe("rules CRUD (real Postgres)", () => {
  it("creates, lists, gets, patches and deletes a rule", async () => {
    if (!TEST_DB) return;
    const createRes = await rules.POST(post({ name: "R", trigger_type: "keyword", trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] }, response_type: "text", response_config: { text: "yo" } }));
    expect(createRes.status).toBe(201);
    const id = (await createRes.json()).data.id;

    const listed = (await (await rules.GET(get())).json()).data;
    expect(listed.map((r: { id: string }) => r.id)).toContain(id);

    const ctx = { params: Promise.resolve({ ruleId: id }) };
    const patched = await rule.PATCH(post({ is_active: false }), ctx);
    expect((await patched.json()).data.is_active).toBe(false);

    const del = await rule.DELETE(get() as never, ctx);
    expect(del.status).toBe(204);
    const gone = await rule.GET(get(), ctx);
    expect(gone.status).toBe(404);
  });
});

describe("sequences CRUD + enroll (real Postgres)", () => {
  it("creates, patches (activate), enrolls a contact, and blocks double-enroll", async () => {
    if (!TEST_DB) return;
    const createRes = await seqs.POST(post({ name: "S", steps: [{ type: "message", content: "hi" }] }));
    expect(createRes.status).toBe(201);
    const id = (await createRes.json()).data.id;

    const listed = (await (await seqs.GET(get())).json()).data;
    expect(listed.find((x: { id: string }) => x.id === id)._count.enrollments).toBe(0);

    const ctx = { params: Promise.resolve({ sequenceId: id }) };
    await seq.PATCH(post({ status: "active" }), ctx);

    const e1 = await enroll.POST(post({ contact_id: CONTACT, channel_id: CH }), ctx);
    expect(e1.status).toBe(201);
    const e2 = await enroll.POST(post({ contact_id: CONTACT, channel_id: CH }), ctx);
    expect(e2.status).toBe(409);

    const del = await seq.DELETE(get() as never, ctx);
    expect(del.status).toBe(204);
  });
});
