import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations, runOnce } from "graphile-worker";
import { eq } from "drizzle-orm";
import { workspaces, channels, autoReplyRules, messages } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "smoke-app-secret";

let pool: Pool;
let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let POST: typeof import("./route").POST;
let processIncomingMessage: typeof import("@/lib/workers/incoming-message-worker").processIncomingMessage;
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
