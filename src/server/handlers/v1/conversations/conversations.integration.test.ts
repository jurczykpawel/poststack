import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "rs_live_conversations_key_abcdef01234";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let list: typeof import("./route");
let detail: typeof import("./[conversationId]/route");
let msgs: typeof import("./[conversationId]/messages/route");
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000b1";
const CH = "eeeeeeee-0000-0000-0000-0000000000b2";
const CONTACT = "eeeeeeee-0000-0000-0000-0000000000b3";
const CONV = "eeeeeeee-0000-0000-0000-0000000000b4";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  list = await import("./route");
  detail = await import("./[conversationId]/route");
  msgs = await import("./[conversationId]/messages/route");
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "Cv", slug: `cv-${WS}` });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-CV", display_name: "Page", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS, display_name: "Jane" });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-CV", platform_username: "jane" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook", status: "open", last_message_at: new Date(), last_message_preview: "hi" });
  await db.insert(s.messages).values({ conversation_id: CONV, direction: "inbound", text: "hi", status: "delivered" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "rs_live_cv" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

const req = (path = "", init?: RequestInit) =>
  new Request(`http://x/api/v1/conversations${path}`, { headers: { authorization: `Bearer ${RAW_KEY}` }, ...init });
const ctx = { params: Promise.resolve({ conversationId: CONV }) };

describe("conversations handlers (real Postgres)", () => {
  it("lists conversations with nested channel + contact", async () => {
    if (!TEST_DB) return;
    const { data } = await (await list.GET(req())).json();
    const c = data.find((x: { id: string }) => x.id === CONV);
    expect(c.channel).toMatchObject({ id: CH, platform: "facebook" });
    expect(c.contact.contact_channels[0].platform_sender_id).toBe("PSID-CV");
  });

  //  — keyset pagination must page past a NULL last_message_at: a usable next_cursor and
  // no lost/duplicated rows.
  it("paginates past a conversation with NULL last_message_at", async () => {
    if (!TEST_DB) return;
    const CONTACT2 = "eeeeeeee-0000-4000-8000-0000000000d0";
    const CONV2 = "eeeeeeee-0000-4000-8000-0000000000d1";
    await db.insert(s.contacts).values({ id: CONTACT2, workspace_id: WS, display_name: "Null" });
    await db.insert(s.conversations).values({ id: CONV2, workspace_id: WS, channel_id: CH, contact_id: CONTACT2, platform: "facebook", status: "open", last_message_at: null });

    const p1 = await (await list.GET(req("?limit=1"))).json();
    expect(p1.data.length).toBe(1);
    expect(p1.meta.has_more).toBe(true);
    expect(p1.meta.next_cursor).toBeTruthy(); // usable cursor even though the next row is NULL

    const p2 = await (await list.GET(req(`?limit=1&cursor=${encodeURIComponent(p1.meta.next_cursor)}`))).json();
    expect(p2.data.length).toBe(1);
    expect(p2.data[0].id).not.toBe(p1.data[0].id); // no duplicate across pages
    expect(new Set([p1.data[0].id, p2.data[0].id])).toEqual(new Set([CONV, CONV2])); // both reached
  });

  it("rejects an invalid conversations cursor (422)", async () => {
    if (!TEST_DB) return;
    const res = await list.GET(req("?cursor=not-a-valid-cursor!!"));
    expect(res.status).toBe(422);
  });

  it("gets a conversation by id (own workspace)", async () => {
    if (!TEST_DB) return;
    const res = await detail.GET(req(`/${CONV}`), ctx);
    expect(res.status).toBe(200);
  });

  //  — assigning a conversation is restricted to members of its workspace.
  it("rejects assigning to a non-member (422), accepts a workspace member (200)", async () => {
    if (!TEST_DB) return;
    // Valid v4 UUIDs (version nibble 4, variant 8) — assigned_to is zod .uuid()-validated.
    const MEMBER = "eeeeeeee-0000-4000-8000-0000000000c1";
    const OUTSIDER = "eeeeeeee-0000-4000-8000-0000000000c2";
    // Users are global (not workspace-cascaded) — clear any leftovers first so the test is idempotent.
    await db.delete(s.users).where(eq(s.users.id, MEMBER));
    await db.delete(s.users).where(eq(s.users.id, OUTSIDER));
    await db.insert(s.users).values([{ id: MEMBER, email: `m-${MEMBER}@x.test` }, { id: OUTSIDER, email: `o-${OUTSIDER}@x.test` }]);
    await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: MEMBER });

    const patch = (assigned_to: string) =>
      detail.PATCH(
        req(`/${CONV}`, { method: "PATCH", headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ assigned_to }) }),
        ctx,
      );

    expect((await patch(OUTSIDER)).status).toBe(422);
    const okRes = await patch(MEMBER);
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).data.assigned_to).toBe(MEMBER);

    // cleanup (users are global, not workspace-cascaded)
    await db.delete(s.users).where(eq(s.users.id, MEMBER));
    await db.delete(s.users).where(eq(s.users.id, OUTSIDER));
  });

  it("lists messages chronologically", async () => {
    if (!TEST_DB) return;
    const { data } = await (await msgs.GET(req(`/${CONV}/messages`), ctx)).json();
    expect(data.length).toBe(1);
    expect(data[0].text).toBe("hi");
  });

  it("posts a manual reply and enqueues an outgoing message", async () => {
    if (!TEST_DB) return;
    const res = await msgs.POST(
      req(`/${CONV}/messages`, { method: "POST", headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ text: "thanks" }) }),
      ctx,
    );
    expect(res.status).toBe(201);
    const jobs = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'`);
    expect(Number((jobs.rows[0] as { n: number }).n)).toBe(1);
  });

  //  — a client retry carrying the same Idempotency-Key must enqueue at most one reply.
  it("deduplicates a retried manual reply by Idempotency-Key", async () => {
    if (!TEST_DB) return;
    const send = () => msgs.POST(
      req(`/${CONV}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json", "Idempotency-Key": "client-retry-1" },
        body: JSON.stringify({ text: "thanks" }),
      }),
      ctx,
    );
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201); // retry, same key
    const jobs = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'`);
    expect(Number((jobs.rows[0] as { n: number }).n)).toBe(1); // exactly one enqueued
  });
});
