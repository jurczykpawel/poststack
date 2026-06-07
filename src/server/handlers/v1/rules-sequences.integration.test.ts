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

describe("rule config exposure: post scoping + reply mode + AI prompt (real Postgres)", () => {
  it("round-trips post_id, reply_mode and comment_reply_text on a comment rule", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "Scoped",
      trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }], post_id: "POST_123" },
      response_type: "text",
      response_config: { text: "check DM", reply_mode: "both", comment_reply_text: "sent you a DM!" },
    }));
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id;

    const got = await rule.GET(get(), { params: Promise.resolve({ ruleId: id }) });
    const data = (await got.json()).data;
    expect(data.trigger_config.post_id).toBe("POST_123");
    expect(data.response_config.reply_mode).toBe("both");
    expect(data.response_config.comment_reply_text).toBe("sent you a DM!");
  });

  it("round-trips custom_prompt on an ai_rephrase rule", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "AI",
      trigger_type: "comment_keyword",
      trigger_config: { post_id: "POST_9" },
      response_type: "ai_rephrase",
      response_config: { text: "thanks!", custom_prompt: "Reply warmly, max 1 sentence.", reply_mode: "comment" },
    }));
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.response_config.custom_prompt).toBe("Reply warmly, max 1 sentence.");
  });

  it("accepts a comment rule scoped to a post with no keywords (any comment on that post)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "AnyComment",
      trigger_type: "comment_keyword",
      trigger_config: { post_id: "POST_ONLY" },
      response_type: "text",
      response_config: { text: "hi", reply_mode: "comment" },
    }));
    expect(res.status).toBe(201);
  });

  it("rejects a comment rule with neither keywords nor post_id (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "Bad",
      trigger_type: "comment_keyword",
      trigger_config: {},
      response_type: "text",
      response_config: { text: "hi" },
    }));
    expect(res.status).toBe(422);
  });

  it("rejects a text rule with no text (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "Empty",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: {},
    }));
    expect(res.status).toBe(422);
  });

  it("rejects unknown keys in trigger_config (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "Junk",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }], bogus: 1 },
      response_type: "text",
      response_config: { text: "hi" },
    }));
    expect(res.status).toBe(422);
  });

  it("round-trips quick replies and buttons on a rule", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "Interactive",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: {
        text: "Pick:",
        quick_replies: [
          { content_type: "text", title: "Yes", payload: "YES" },
          { content_type: "user_email" },
        ],
        buttons: [
          { title: "Claim", payload: "CLAIM_LM" },
          { title: "Site", url: "https://example.com" },
        ],
      },
    }));
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.response_config.quick_replies).toHaveLength(2);
    expect(data.response_config.buttons[0]).toEqual({ title: "Claim", payload: "CLAIM_LM" });
  });

  it("defaults quick reply content_type to text", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "QRDefault",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "Pick:", quick_replies: [{ title: "Yes", payload: "Y" }] },
    }));
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.response_config.quick_replies[0].content_type).toBe("text");
  });

  it("rejects more than 13 quick replies (422)", async () => {
    if (!TEST_DB) return;
    const quick_replies = Array.from({ length: 14 }, (_, i) => ({ content_type: "text", title: `q${i}`, payload: `P${i}` }));
    const res = await rules.POST(post({
      name: "TooMany",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "Pick:", quick_replies },
    }));
    expect(res.status).toBe(422);
  });

  it("rejects a text quick reply without a title (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "NoTitle",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "Pick:", quick_replies: [{ content_type: "text", payload: "P" }] },
    }));
    expect(res.status).toBe(422);
  });

  it("rejects a button with both url and payload (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "AmbiguousBtn",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "t", buttons: [{ title: "X", url: "https://x", payload: "P" }] },
    }));
    expect(res.status).toBe(422);
  });

  it("rejects a button title longer than 20 chars (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "LongBtn",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "t", buttons: [{ title: "x".repeat(21), payload: "P" }] },
    }));
    expect(res.status).toBe(422);
  });

  it("rejects more than 3 buttons (422)", async () => {
    if (!TEST_DB) return;
    const buttons = Array.from({ length: 4 }, (_, i) => ({ title: `b${i}`, payload: `P${i}` }));
    const res = await rules.POST(post({
      name: "TooManyBtn",
      trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "t", buttons },
    }));
    expect(res.status).toBe(422);
  });

  it("creates a follow_gate postback rule with followed + not_followed branches", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "FollowGate",
      trigger_type: "postback",
      trigger_config: { payload: "CLAIM_LM" },
      response_type: "follow_gate",
      response_config: {
        followed: { text: "Here's your guide: https://x/guide" },
        not_followed: { text: "Please follow first 🙏", buttons: [{ title: "Chcę odebrać", payload: "CLAIM_LM" }] },
      },
    }));
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(data.response_type).toBe("follow_gate");
    expect(data.response_config.not_followed.buttons[0].payload).toBe("CLAIM_LM");
  });

  it("rejects a follow_gate rule missing the not_followed branch (422)", async () => {
    if (!TEST_DB) return;
    const res = await rules.POST(post({
      name: "GateBad",
      trigger_type: "postback",
      trigger_config: { payload: "CLAIM_LM" },
      response_type: "follow_gate",
      response_config: { followed: { text: "guide" } },
    }));
    expect(res.status).toBe(422);
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
