import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations, runOnce } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "smoke-app-secret";

let pool: Pool;
let prisma: typeof import("@/lib/prisma").prisma;
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

  ({ prisma } = await import("@/lib/prisma"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ POST } = await import("./route"));
  ({ processIncomingMessage } = await import("@/lib/workers/incoming-message-worker"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: "Smoke", slug: `smoke-${WS}` } });
  await prisma.channel.create({
    data: {
      id: CH, workspace_id: WS, platform: "facebook", platform_id: PAGE,
      token_encrypted: encryptTokens({ access_token: "tok" }), webhook_secret: "wh", status: "active",
    },
  });
  await prisma.autoReplyRule.create({
    data: {
      workspace_id: WS, channel_id: null, name: "Hello rule", is_active: true,
      trigger_type: "keyword", trigger_config: { keywords: [{ value: "hello", match_type: "contains" }] },
      response_type: "text", response_config: { text: "Auto reply!" },
    },
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await prisma.workspace.deleteMany({ where: { id: WS } });
  if (closeQueue) await closeQueue();
  await prisma.$disconnect();
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
    const inbound = await prisma.message.findFirst({ where: { platform_message_id: "mid-e2e" } });
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
