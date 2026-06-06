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

  it("gets a conversation by id (own workspace)", async () => {
    if (!TEST_DB) return;
    const res = await detail.GET(req(`/${CONV}`), ctx);
    expect(res.status).toBe(200);
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
});
