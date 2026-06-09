import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations, runOnce } from "graphile-worker";
import { eq } from "drizzle-orm";
import { workspaces, channels, autoReplyRules, messages, commentLogs, contactChannels, contacts } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "smoke-app-secret";

let pool: Pool;
let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let POST: typeof import("./route").POST;
let processIncomingMessage: typeof import("@/lib/workers/incoming-message-worker").processIncomingMessage;
let processIncomingComment: typeof import("@/lib/workers/incoming-comment-worker").processIncomingComment;
let processOutgoingPrivateReply: typeof import("@/lib/workers/outgoing-private-reply-worker").processOutgoingPrivateReply;
let processFollowGate: typeof import("@/lib/workers/follow-gate-worker").processFollowGate;
let processOutgoingMessage: typeof import("@/lib/workers/outgoing-message-worker").processOutgoingMessage;
let telegramWebhookPost: typeof import("@/server/handlers/webhooks/telegram/route").POST;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-000000000001";
const CH = "eeeeeeee-0000-0000-0000-000000000002";
const PAGE = "PAGE-E2E";
const PSID = "PSID-E2E";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify";

  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });

  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ POST } = await import("./route"));
  ({ processIncomingMessage } = await import("@/lib/workers/incoming-message-worker"));
  ({ processIncomingComment } = await import("@/lib/workers/incoming-comment-worker"));
  ({ processOutgoingPrivateReply } = await import("@/lib/workers/outgoing-private-reply-worker"));
  ({ processFollowGate } = await import("@/lib/workers/follow-gate-worker"));
  ({ processOutgoingMessage } = await import("@/lib/workers/outgoing-message-worker"));
  ({ POST: telegramWebhookPost } = await import("@/server/handlers/webhooks/telegram/route"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Smoke", slug: `smoke-${WS}` });
  await db.insert(channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE,
    token_encrypted: encryptTokens({ access_token: "tok" }), webhook_secret: "wh", status: "active",
  });
  await db.insert(autoReplyRules).values({
    workspace_id: WS, channel_id: null, name: "Hello rule", is_active: true,
    trigger_type: "keyword", trigger_config: { keywords: [{ value: "hello", match_type: "contains" }] },
    response_type: "text", response_config: { text: "Auto reply!" },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  if (closeQueue) await closeQueue();
  await db.$client.end();
  await pool.end();
});

function signedWebhook(mid: string, text: string) {
  const body = JSON.stringify({
    object: "page",
    entry: [
      {
        id: PAGE,
        messaging: [
          {
            sender: { id: PSID },
            recipient: { id: PAGE },
            timestamp: 1_770_000_000_000,
            message: { mid, text },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
  return new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
    body,
  });
}

function signed(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`;
  return new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": signature, "content-type": "application/json" },
    body,
  });
}

describe("Meta webhook input hardening (real Postgres)", () => {
  //  — an oversized body is rejected before it is buffered or the HMAC runs.
  it("rejects an oversized body with 413 before buffering", async () => {
    if (!TEST_DB) return;
    const bigReq = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "2000000" : null) },
      text: async () => "",
    } as unknown as Request;
    const res = await POST(bigReq);
    expect(res.status).toBe(413);
  });

  //  — a signed event missing `sender` is skipped (200, no enqueue), not a 500 retry storm.
  it("skips a messaging event with no sender (200, no job)", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "page",
      entry: [{ id: "FB_PAGE", messaging: [{ message: { mid: "no-sender-mid" }, timestamp: 1_770_000_000_000 }] }],
    }));
    expect(res.status).toBe(200);
    const n = await pool.query("select count(*)::int as n from graphile_worker.jobs where key = $1", ["msg-no-sender-mid"]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe("webhook ingestion: Instagram comments (real Postgres)", () => {
  it("ingests a Facebook page comment (field=feed) and enqueues incoming-comment", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: "FB_PAGE",
        changes: [{
          field: "feed",
          value: { item: "comment", verb: "add", comment_id: "FB_CMT_1", post_id: "POST_7", message: "info", from: { id: "ASID1", name: "Bob" } },
        }],
      }],
    }));
    expect(res.status).toBe(200);
    const job = await pool.query(
      "select j.task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      ["comment-FB_CMT_1"],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].payload.postId).toBe("POST_7");
    expect(job.rows[0].payload.platform).toBe("facebook");
  });

  it("ingests an Instagram comment (field=comments) and enqueues incoming-comment", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "instagram",
      entry: [{
        id: "IG_PAGE",
        changes: [{
          field: "comments",
          value: { id: "IG_CMT_1", text: "info please", from: { id: "IGSID1", username: "jane" }, media: { id: "MEDIA_1" } },
        }],
      }],
    }));
    expect(res.status).toBe(200);

    const job = await pool.query(
      "select j.task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      ["comment-IG_CMT_1"],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].task_identifier).toBe("incoming-comment");
    const p = job.rows[0].payload;
    expect(p.platform).toBe("instagram");
    expect(p.commentId).toBe("IG_CMT_1");
    expect(p.postId).toBe("MEDIA_1");
    expect(p.text).toBe("info please");
    expect(p.senderId).toBe("IGSID1");
    expect(p.senderName).toBe("jane");
    //  — the unused full-event `raw` field is no longer serialized into the queue.
    expect(p.raw).toBeUndefined();
  });

  it("flags a story reply (message.reply_to.story) on the incoming-message job", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "instagram",
      entry: [{
        id: "IG_PAGE",
        messaging: [{
          sender: { id: "IGSID2" }, recipient: { id: "IG_PAGE" }, timestamp: 1_770_000_000_000,
          message: { mid: "mid-story-reply", text: "love it", reply_to: { story: { id: "STORY_1" } } },
        }],
      }],
    }));
    expect(res.status).toBe(200);
    const job = await pool.query(
      "select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      ["msg-mid-story-reply"],
    );
    expect(job.rows[0].payload.isStoryReply).toBe(true);
    expect(job.rows[0].payload.storyId).toBe("STORY_1");
  });

  it("ingests an emoji reaction (messaging.reaction) and enqueues incoming-reaction", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: PAGE,
        messaging: [{
          sender: { id: "REACTOR" }, recipient: { id: PAGE }, timestamp: 1_770_000_000_000,
          reaction: { mid: "MID_REACTED", action: "react", reaction: "love", emoji: "❤️" },
        }],
      }],
    }));
    expect(res.status).toBe(200);
    const job = await pool.query(
      "select j.task_identifier, pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      ["reaction-REACTOR-MID_REACTED-1770000000000"],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].task_identifier).toBe("incoming-reaction");
    expect(job.rows[0].payload.reactionType).toBe("love");
    expect(job.rows[0].payload.reactedMid).toBe("MID_REACTED");
  });

  it("ignores an unreact event", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: PAGE,
        messaging: [{
          sender: { id: "REACTOR" }, recipient: { id: PAGE }, timestamp: 1_770_000_000_001,
          reaction: { mid: "MID_UN", action: "unreact" },
        }],
      }],
    }));
    expect(res.status).toBe(200);
    const job = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'incoming-reaction' and key like 'reaction-REACTOR-MID_UN%'");
    expect(job.rows[0].n).toBe(0);
  });

  it("flags a story mention (attachments[].type=story_mention) on the incoming-message job", async () => {
    if (!TEST_DB) return;
    const res = await POST(signed({
      object: "instagram",
      entry: [{
        id: "IG_PAGE",
        messaging: [{
          sender: { id: "IGSID3" }, recipient: { id: "IG_PAGE" }, timestamp: 1_770_000_000_000,
          message: { mid: "mid-story-mention", attachments: [{ type: "story_mention", payload: { url: "x" } }] },
        }],
      }],
    }));
    expect(res.status).toBe(200);
    const job = await pool.query(
      "select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      ["msg-mid-story-mention"],
    );
    expect(job.rows[0].payload.isStoryMention).toBe(true);
  });
});

describe("smoke E2E: webhook → worker → auto-reply (real Postgres)", () => {
  it("ingests a DM, the incoming worker fires a rule, and a reply is enqueued", async () => {
    if (!TEST_DB) return;

    // 1. Signed webhook → 200 + an incoming-message job enqueued.
    const res = await POST(signedWebhook("mid-e2e", "hello there"));
    expect(res.status).toBe(200);

    const incoming = await pool.query(
      "select task_identifier from graphile_worker.jobs where key = $1",
      ["msg-mid-e2e"],
    );
    expect(incoming.rows).toHaveLength(1);
    expect(incoming.rows[0].task_identifier).toBe("incoming-message");

    // 2. Run only the incoming-message task — it persists the DM and enqueues a reply.
    await runOnce({
      connectionString: TEST_DB,
      taskList: {
        "incoming-message": async (p, h) =>
          processIncomingMessage(p as Parameters<typeof processIncomingMessage>[0], h),
      },
    });

    // 3. The inbound message is stored.
    const inbound = await db.query.messages.findFirst({ where: eq(messages.platform_message_id, "mid-e2e") });
    expect(inbound?.direction).toBe("inbound");

    // 4. The rule fired → an outgoing-message (the auto-reply) is now queued.
    const outgoing = await pool.query(
      "select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'",
    );
    expect(outgoing.rows[0].n).toBe(1);
  });

  it("ingests a comment on a post, fires a post-scoped rule, and enqueues public + private reply", async () => {
    if (!TEST_DB) return;
    await db.insert(autoReplyRules).values({
      workspace_id: WS, channel_id: null, name: "Post rule", is_active: true,
      trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }], post_id: "POST_E2E" },
      response_type: "text",
      response_config: { text: "Check your DMs!", reply_mode: "both", comment_reply_text: "Replied 🙌" },
    });

    // 1. Signed comment webhook → 200 + incoming-comment enqueued.
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: PAGE,
        changes: [{
          field: "feed",
          value: { item: "comment", verb: "add", comment_id: "CMT_E2E", post_id: "POST_E2E", message: "need info pls", from: { id: "FAN_1", name: "Fan" } },
        }],
      }],
    }));
    expect(res.status).toBe(200);

    // 2. Run only the incoming-comment task.
    await runOnce({
      connectionString: TEST_DB,
      taskList: {
        "incoming-comment": async (p, h) =>
          processIncomingComment(p as Parameters<typeof processIncomingComment>[0], h),
      },
    });

    // 3. Comment logged, contact + conversation materialised first-touch.
    const log = await db.query.commentLogs.findFirst({ where: eq(commentLogs.platform_comment_id, "CMT_E2E") });
    expect(log).toBeTruthy();
    const cc = await db.select().from(contactChannels).where(eq(contactChannels.platform_sender_id, "FAN_1"));
    expect(cc.length).toBe(1);

    // 4. Both a public comment reply and a private reply are queued.
    const pub = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-comment'");
    const priv = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-private-reply'");
    expect(pub.rows[0].n).toBe(1);
    expect(priv.rows[0].n).toBe(1);
  });

  it("comment → first-touch private reply DM carries a button template to the Graph API", async () => {
    if (!TEST_DB) return;
    await db.insert(autoReplyRules).values({
      workspace_id: WS, channel_id: null, name: "Button DM", is_active: true,
      trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }], post_id: "POST_BTN" },
      response_type: "text",
      response_config: {
        text: "Tap to claim your guide:",
        reply_mode: "dm",
        buttons: [{ title: "Chcę odebrać", payload: "CLAIM_LM" }],
      },
    });

    // 1. Comment webhook → 200 + incoming-comment enqueued.
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: PAGE,
        changes: [{
          field: "feed",
          value: { item: "comment", verb: "add", comment_id: "CMT_BTN", post_id: "POST_BTN", message: "send info", from: { id: "FAN_BTN", name: "Fan" } },
        }],
      }],
    }));
    expect(res.status).toBe(200);

    // 2. Incoming-comment worker → enqueues outgoing-private-reply with button content.
    await runOnce({
      connectionString: TEST_DB,
      taskList: { "incoming-comment": async (p, h) => processIncomingComment(p as Parameters<typeof processIncomingComment>[0], h) },
    });

    // 3. Outgoing-private-reply worker → real provider.sendPrivateReply; mock the Graph API boundary.
    const calls: Array<{ url: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(init!.body as string) });
      return Response.json({ recipient_id: "FAN_BTN", message_id: "m_btn_1" });
    }) as typeof fetch;

    try {
      await runOnce({
        connectionString: TEST_DB,
        taskList: { "outgoing-private-reply": async (p, h) => processOutgoingPrivateReply(p as Parameters<typeof processOutgoingPrivateReply>[0], h) },
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    // 4. Exactly one Graph API send, addressed by comment_id, carrying the button template.
    const send = calls.find((c) => c.url.includes("/me/messages"));
    expect(send).toBeDefined();
    const body = send!.body as { recipient: { comment_id: string }; message: { attachment: { payload: { template_type: string; text: string; buttons: unknown[] } } } };
    expect(body.recipient).toEqual({ comment_id: "CMT_BTN" });
    expect(body.message.attachment.payload.template_type).toBe("button");
    expect(body.message.attachment.payload.text).toBe("Tap to claim your guide:");
    expect(body.message.attachment.payload.buttons).toEqual([
      { type: "postback", title: "Chcę odebrać", payload: "CLAIM_LM" },
    ]);
  });

  it("does not fire a post-scoped rule for a comment on a different post", async () => {
    if (!TEST_DB) return;
    await db.insert(autoReplyRules).values({
      workspace_id: WS, channel_id: null, name: "Post rule", is_active: true,
      trigger_type: "comment_keyword",
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }], post_id: "POST_ONLY" },
      response_type: "text", response_config: { text: "x", reply_mode: "comment", comment_reply_text: "y" },
    });
    const res = await POST(signed({
      object: "page",
      entry: [{
        id: PAGE,
        changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "CMT_OTHER", post_id: "DIFFERENT_POST", message: "info", from: { id: "FAN_2", name: "F" } } }],
      }],
    }));
    expect(res.status).toBe(200);
    await runOnce({
      connectionString: TEST_DB,
      taskList: { "incoming-comment": async (p, h) => processIncomingComment(p as Parameters<typeof processIncomingComment>[0], h) },
    });
    const pub = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-comment'");
    expect(pub.rows[0].n).toBe(0);
  });

  it("rejects a webhook with a bad signature", async () => {
    if (!TEST_DB) return;
    const bad = new Request("http://x/api/webhooks/meta", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
      body: JSON.stringify({ object: "page", entry: [] }),
    });
    const res = await POST(bad);
    expect(res.status).toBe(403);
  });
});

describe("follow-gate E2E: postback → follow check → gated reply (real Postgres)", () => {
  const IG_CH = "eeeeeeee-0000-0000-0000-0000000000fe";
  const IG_PAGE = "IG_PAGE_FG";
  const IGSID = "IGSID_FG";

  // Drives a tap on the claim button through the full pipeline up to (but not
  // running) the follow-gate job, which the test then runs with a mocked
  // follow status. Returns nothing — jobs are queued in Postgres.
  async function tapClaimButton() {
    await db.insert(channels).values({
      id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: IG_PAGE,
      token_encrypted: encryptTokens({ access_token: "ig-tok" }), webhook_secret: "wh", status: "active",
    });
    await db.insert(autoReplyRules).values({
      workspace_id: WS, channel_id: null, name: "Follow gate", is_active: true,
      trigger_type: "postback", trigger_config: { payload: "CLAIM_LM" },
      response_type: "follow_gate",
      response_config: {
        followed: { text: "Here is your guide: https://example.com/guide" },
        not_followed: { text: "Please follow us first, then tap again 🙏", buttons: [{ title: "Chcę odebrać", payload: "CLAIM_LM" }] },
      },
    });

    const res = await POST(signed({
      object: "instagram",
      entry: [{
        id: IG_PAGE,
        messaging: [{
          sender: { id: IGSID }, recipient: { id: IG_PAGE }, timestamp: 1_770_000_111_000,
          postback: { payload: "CLAIM_LM", title: "Chcę odebrać" },
        }],
      }],
    }));
    expect(res.status).toBe(200);

    await runOnce({
      connectionString: TEST_DB,
      taskList: { "incoming-message": async (p, h) => processIncomingMessage(p as Parameters<typeof processIncomingMessage>[0], h) },
    });
    const fg = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'follow-gate'");
    expect(fg.rows[0].n).toBe(1);
  }

  // Runs the follow-gate worker (live follow check) then the outgoing-message
  // worker, with the Graph API mocked. Returns the captured /me/messages send.
  async function drainWithFollowStatus(isFollowing: boolean) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("is_user_follow_business")) return Response.json({ is_user_follow_business: isFollowing });
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return Response.json({ recipient_id: IGSID, message_id: "m_fg" });
    }) as typeof fetch;
    try {
      await runOnce({
        connectionString: TEST_DB,
        taskList: { "follow-gate": async (p, h) => processFollowGate(p as Parameters<typeof processFollowGate>[0], h) },
      });
      await runOnce({
        connectionString: TEST_DB,
        taskList: { "outgoing-message": async (p, h) => processOutgoingMessage(p as Parameters<typeof processOutgoingMessage>[0], h) },
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    return calls.find((c) => c.url.includes("/me/messages"));
  }

  it("re-prompts with the claim button when the user does not follow yet", async () => {
    if (!TEST_DB) return;
    await tapClaimButton();
    const send = await drainWithFollowStatus(false);
    expect(send).toBeDefined();
    const msg = send!.body.message as { attachment: { payload: { text: string; buttons: unknown[] } } };
    expect(msg.attachment.payload.text).toBe("Please follow us first, then tap again 🙏");
    expect(msg.attachment.payload.buttons).toEqual([
      { type: "postback", title: "Chcę odebrać", payload: "CLAIM_LM" },
    ]);
  });

  it("delivers the guide once the user follows", async () => {
    if (!TEST_DB) return;
    await tapClaimButton();
    const send = await drainWithFollowStatus(true);
    expect(send).toBeDefined();
    const msg = send!.body.message as { text?: string; attachment?: unknown };
    expect(msg.text).toBe("Here is your guide: https://example.com/guide");
    expect(msg.attachment).toBeUndefined();
  });
});

describe("Telegram E2E: webhook → worker → reply (real Postgres)", () => {
  const TG_CH = "eeeeeeee-0000-0000-0000-0000000000fd";
  const BOT = "BOT_TG";
  const TG_SECRET = "tg-secret-xyz";
  const CHAT = "555444333";

  function tgUpdate(text: string, opts: { secret?: string; messageId?: number; chatId?: string; date?: number } = {}) {
    const { secret = TG_SECRET, messageId = 99, chatId = CHAT, date = 1_770_000_000 } = opts;
    return new Request("http://x/api/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({
        update_id: messageId,
        message: {
          message_id: messageId,
          from: { id: Number(chatId), is_bot: false, first_name: "Jan" },
          chat: { id: Number(chatId), type: "private" },
          date,
          text,
        },
      }),
    });
  }

  async function seedTgChannel() {
    await db.insert(channels).values({
      id: TG_CH, workspace_id: WS, platform: "telegram", platform_id: BOT,
      token_encrypted: encryptTokens({ access_token: "bot-token" }), webhook_secret: TG_SECRET, status: "active",
    });
  }

  it("ignores an update whose secret matches no channel (no job)", async () => {
    if (!TEST_DB) return;
    await seedTgChannel();
    const res = await telegramWebhookPost(tgUpdate("hello", { secret: "wrong-secret" }));
    expect(res.status).toBe(200);
    const n = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'incoming-message'");
    expect(n.rows[0].n).toBe(0);
  });

  //  — a text message without a `chat` must be ignored (200, no job), not 500 into a retry loop.
  it("ignores a text update missing chat (no 500, no job)", async () => {
    if (!TEST_DB) return;
    await seedTgChannel();
    const req = new Request("http://x/api/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": TG_SECRET },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, text: "hi" } }),
    });
    const res = await telegramWebhookPost(req);
    expect(res.status).toBe(200);
    const n = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'incoming-message'");
    expect(n.rows[0].n).toBe(0);
  });

  //  — an oversized body is rejected (200, ignored) before it is buffered/parsed.
  it("ignores an oversized body before buffering", async () => {
    if (!TEST_DB) return;
    const bigReq = {
      headers: { get: (k: string) => (k.toLowerCase() === "content-length" ? "300000" : k.toLowerCase() === "x-telegram-bot-api-secret-token" ? TG_SECRET : null) },
      json: async () => ({}),
    } as unknown as Request;
    const res = await telegramWebhookPost(bigReq);
    expect(res.status).toBe(200);
  });

  it("ingests a text message, fires the keyword rule, and sends a Telegram reply", async () => {
    if (!TEST_DB) return;
    await seedTgChannel();
    // beforeEach seeded "Hello rule" (keyword "hello", channel_id null) — applies to Telegram too.
    const res = await telegramWebhookPost(tgUpdate("hello there"));
    expect(res.status).toBe(200);
    // jobKey + payload identity include bot + chat + message (FIXR2/FIXR3/FIXR7).
    const enq = await pool.query(
      "select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.key = $1",
      [`tg-${BOT}-${CHAT}-99`],
    );
    expect(enq.rows).toHaveLength(1);
    const jp = enq.rows[0].payload as { channelId: string; mid: string; timestamp: number; pageId: string };
    expect(jp.channelId).toBe(TG_CH);
    expect(jp.mid).toBe(`${BOT}-${CHAT}-99`);
    expect(jp.timestamp).toBe(1_770_000_000); // seconds, not pre-multiplied

    await runOnce({
      connectionString: TEST_DB,
      taskList: { "incoming-message": async (p, h) => processIncomingMessage(p as Parameters<typeof processIncomingMessage>[0], h) },
    });
    expect((await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'outgoing-message'")).rows[0].n).toBe(1);

    // FIXR7: contact's last interaction reflects the event time, not processing time.
    const contact = await db.query.contacts.findFirst({ where: eq(contacts.workspace_id, WS), columns: { last_interaction_at: true } });
    expect(contact?.last_interaction_at?.getTime()).toBe(1_770_000_000_000);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(init!.body as string) });
      return Response.json({ ok: true, result: { message_id: 1001 } });
    }) as typeof fetch;
    try {
      await runOnce({
        connectionString: TEST_DB,
        taskList: { "outgoing-message": async (p, h) => processOutgoingMessage(p as Parameters<typeof processOutgoingMessage>[0], h) },
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeDefined();
    expect(send!.url).toContain("api.telegram.org/botbot-token/sendMessage");
    expect(send!.body.chat_id).toBe(CHAT);
    expect(send!.body.text).toBe("Auto reply!");
  });

  it("does not dedup the same message_id across different chats (FIXR3)", async () => {
    if (!TEST_DB) return;
    await seedTgChannel();
    await telegramWebhookPost(tgUpdate("hi", { messageId: 7, chatId: "111" }));
    await telegramWebhookPost(tgUpdate("hi", { messageId: 7, chatId: "222" })); // same message_id, different chat
    const n = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'incoming-message'");
    expect(n.rows[0].n).toBe(2);
    // ...but a true duplicate (same bot+chat+message) is deduped.
    await telegramWebhookPost(tgUpdate("hi", { messageId: 7, chatId: "111" }));
    const n2 = await pool.query("select count(*)::int as n from graphile_worker.jobs where task_identifier = 'incoming-message'");
    expect(n2.rows[0].n).toBe(2);
  });
});
