import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { Pool } from "pg";
import { runMigrations } from "graphile-worker";
import { eq } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import docs from "../../../../../tests/fixtures/provider-docs/meta-webhooks.json";
import { channels, contactChannels, contacts, conversations, messages, webhookEvents, workspaces } from "@/db/schema";

const TEST_DB = process.env.TEST_DATABASE_URL;
const APP_SECRET = "documented-payload-secret";
const WS = "eeeeeeee-0000-4000-8000-0000000000d1";
const ACCOUNT = "17841400000000001";
const USER = "232323232";
const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

let pool: Pool;
let db: typeof import("@/lib/db").db;
let POST: typeof import("./route").POST;
let processIncomingReceipt: typeof import("@/lib/workers/incoming-receipt-worker").processIncomingReceipt;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

function deliver(payload: unknown) {
  const body = JSON.stringify(payload);
  return POST(new Request("http://x/api/webhooks/meta", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body, "utf8").digest("hex")}`, "content-type": "application/json" },
    body,
  }));
}
async function queued(task: string) {
  const { rows } = await pool.query("select pj.payload from graphile_worker.jobs j join graphile_worker._private_jobs pj on pj.id = j.id where j.task_identifier = $1", [task]);
  return rows.map((row) => row.payload);
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.META_APP_ID = "app-id";
  process.env.META_APP_SECRET = APP_SECRET;
  pool = new Pool({ connectionString: TEST_DB });
  await runMigrations({ connectionString: TEST_DB });
  ({ db } = await import("@/lib/db"));
  ({ POST } = await import("./route"));
  ({ processIncomingReceipt } = await import("@/lib/workers/incoming-receipt-worker"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});
beforeEach(async () => {
  if (!TEST_DB) return;
  await pool.query("truncate table graphile_worker._private_jobs cascade");
  await db.delete(webhookEvents);
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await db.insert(workspaces).values({ id: WS, name: "Docs", slug: `docs-${WS}` });
});
afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(workspaces).where(eq(workspaces.id, WS));
  await closeQueue();
  await db.$client.end();
  await pool.end();
});

describe("Meta webhook payloads as documented", () => {
  it.each([
    ["Business Login comment (field and value on the entry)", docs.igCommentBusinessLogin, "17865799348089039", "123123123"],
    ["Unified Login comment (comment_id)", docs.igCommentUnifiedLogin, "17865799348089040", "123123123"],
    ["Unified Login live comment (comment_id)", docs.igLiveCommentUnifiedLogin, "17865799348089041", "123123124"],
  ])("queues the comment automation for a %s", async (_name, payload, commentId, postId) => {
    if (!TEST_DB) return;
    expect((await deliver(payload)).status).toBe(200);
    expect(await queued("incoming-comment")).toEqual([expect.objectContaining({ platform: "instagram", pageId: ACCOUNT, commentId, postId, senderId: USER, senderName: "doc_user", text: "This is an example." })]);
  });

  it("accepts a comment whose optional text is absent", async () => {
    if (!TEST_DB) return;
    expect((await deliver(docs.igCommentWithoutText)).status).toBe(200);
    const [job] = await queued("incoming-comment");
    expect(job.commentId).toBe("17865799348089042");
    expect(job.text).toBeUndefined();
  });

  it("does not turn a deleted Instagram message into a new inbox message", async () => {
    if (!TEST_DB) return;
    expect((await deliver(docs.igMessageDeleted)).status).toBe(200);
    expect(await queued("incoming-message")).toEqual([]);
    const [row] = await db.select().from(webhookEvents);
    expect(row.platform_message_id).toBe("aWdfZG1fbWlkOjI");
  });

  it("marks our Instagram messages up to the seen one as read from a receipt carrying only mid", async () => {
    if (!TEST_DB) return;
    const [channel] = await db.insert(channels).values({ workspace_id: WS, platform: "instagram", platform_id: ACCOUNT, token_encrypted: "unused", webhook_secret: "unused", status: "active" }).returning();
    const [contact] = await db.insert(contacts).values({ workspace_id: WS }).returning();
    await db.insert(contactChannels).values({ contact_id: contact.id, channel_id: channel.id, platform_sender_id: USER });
    const [conversation] = await db.insert(conversations).values({ workspace_id: WS, channel_id: channel.id, contact_id: contact.id, platform: "instagram" }).returning();
    const at = (seconds: number) => new Date(1_569_262_000_000 + seconds * 1000);
    await db.insert(messages).values([
      { conversation_id: conversation.id, direction: "outbound", platform_message_id: "earlier", created_at: at(1) },
      { conversation_id: conversation.id, direction: "outbound", platform_message_id: "aWdfZG1fbWlkOjE", created_at: at(2) },
      { conversation_id: conversation.id, direction: "outbound", platform_message_id: "later", created_at: at(3) },
    ]);
    expect((await deliver(docs.igSeen)).status).toBe(200);
    const [job] = await queued("incoming-receipt");
    expect(job).toBeTruthy();
    await processIncomingReceipt(job, helpers);
    const rows = await db.select().from(messages).where(eq(messages.conversation_id, conversation.id));
    const read = Object.fromEntries(rows.map((row) => [row.platform_message_id, row.read_at !== null]));
    expect(read).toEqual({ earlier: true, aWdfZG1fbWlkOjE: true, later: false });
  });
});
