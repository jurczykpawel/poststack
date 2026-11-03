import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import recording from "../../../tests/fixtures/inbox/lifecycle.json";
import inbound from "../../../tests/fixtures/inbox/inbound.json";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "c0ffee39-0000-4000-8000-000000000001";
const OTHER = "c0ffee39-0000-4000-8000-000000000002";
const KEY = "sk_live_inbound_events_contract_0123456789";
const CT = recording.contact.id;
const CH = recording.contact.contact_channels[0].channel.id;
const CV = recording.conversation.id;
const SENDER = recording.contact.contact_channels[0].platform_sender_id;
const helpers = { logger: { info() {} }, job: { attempts: 1, max_attempts: 3 } } as unknown as JobHelpers;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let webhooks: typeof import("@/server/handlers/v1/webhooks/route");
let messageRoute: typeof import("@/server/handlers/v1/messages/[messageId]/route");
let commentRoute: typeof import("@/server/handlers/v1/comments/[commentId]/route");
let message: typeof import("@/lib/workers/incoming-message-worker");
let comment: typeof import("@/lib/workers/incoming-comment-worker");
let echo: typeof import("@/lib/workers/incoming-echo-worker");
let queue: typeof import("@/lib/queue/client");

const request = (method: string, body?: unknown, key = KEY) => new Request("http://local/api/v1", {
  method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const events = (type: string) => db.select().from(s.events).where(and(eq(s.events.workspace_id, WS), eq(s.events.type, type)));
const messageJob = (index = 0) => ({
  platform: "instagram", pageId: "inbound39", senderId: SENDER, recipientId: "inbound39",
  mid: inbound.rows[index].platform_message_id, text: inbound.rows[index].text,
  timestamp: Date.parse(inbound.rows[index].created_at) / 1000,
});
const commentJob = (index = 0, extra = {}) => ({
  platform: "facebook", pageId: "inbound39", postId: "post-39", senderName: "Commenter Name", commentId: inbound.rows[index].platform_message_id,
  senderId: SENDER, text: inbound.rows[index].text, timestamp: Date.parse(inbound.rows[index].created_at) / 1000, ...extra,
});

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_TARGETS", "true");
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  webhooks = await import("@/server/handlers/v1/webhooks/route");
  messageRoute = await import("@/server/handlers/v1/messages/[messageId]/route");
  commentRoute = await import("@/server/handlers/v1/comments/[commentId]/route");
  message = await import("@/lib/workers/incoming-message-worker");
  comment = await import("@/lib/workers/incoming-comment-worker");
  echo = await import("@/lib/workers/incoming-echo-worker");
  queue = await import("@/lib/queue/client");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await licenseInstance();
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  for (const id of [WS, OTHER]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
    await db.insert(s.workspaces).values({ id, name: "Inbound", slug: `inbound-${id}` });
  }
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "inbound39", token_encrypted: "x", webhook_secret: "s", status: "paused" });
  await db.insert(s.contacts).values({ id: CT, workspace_id: WS, display_name: recording.contact.display_name });
  await db.insert(s.contactChannels).values({ contact_id: CT, channel_id: CH, platform_sender_id: SENDER });
  await db.insert(s.conversations).values({ id: CV, workspace_id: WS, channel_id: CH, contact_id: CT, platform: "instagram", status: "open" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "Inbound", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "sk_live_ib" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.instanceLicense);
  await queue.closeQueue();
  await db.$client.end();
  vi.unstubAllEnvs();
});

describe.skipIf(!TEST_DB)("message.received and comment.received", () => {
  it("emits message.received with identifiers only, once per new inbound message", async () => {
    await message.processIncomingMessage(messageJob(), helpers);
    await message.processIncomingMessage(messageJob(), helpers);
    const [row] = await events("message.received");
    expect(await events("message.received")).toHaveLength(1);
    const stored = (await db.select().from(s.messages).where(eq(s.messages.conversation_id, CV)))[0]!;
    expect(row).toMatchObject({ subject_type: "message", subject_id: stored.id });
    expect(row!.payload).toEqual({
      workspaceId: WS, channelId: CH, platform: "instagram", conversationId: CV, messageId: stored.id,
      contactId: CT, direction: "inbound", createdAt: stored.created_at.toISOString(),
    });
    expect(JSON.stringify(row!.payload)).not.toContain(inbound.rows[0].text);
  });

  it("emits comment.received with the comment and post identifiers, without text or names", async () => {
    await db.update(s.channels).set({ platform: "facebook" }).where(eq(s.channels.id, CH));
    await comment.processIncomingComment(commentJob(), helpers);
    await comment.processIncomingComment(commentJob(), helpers);
    const [row] = await events("comment.received");
    expect(await events("comment.received")).toHaveLength(1);
    const logged = (await db.select().from(s.commentLogs).where(eq(s.commentLogs.channel_id, CH)))[0]!;
    expect(row).toMatchObject({ subject_type: "comment", subject_id: logged.id });
    expect(row!.payload).toEqual({
      workspaceId: WS, channelId: CH, platform: "facebook", conversationId: logged.conversation_id, commentId: logged.id,
      postId: "post-39", contactId: CT, direction: "inbound", createdAt: logged.created_at.toISOString(),
    });
    const dump = JSON.stringify(row!.payload);
    expect(dump).not.toContain(inbound.rows[0].text);
    expect(dump).not.toContain("Commenter Name");
  });

  it("does not emit for the page's own comment or an echo of our own message", async () => {
    await db.update(s.channels).set({ platform: "facebook" }).where(eq(s.channels.id, CH));
    await comment.processIncomingComment(commentJob(0, { senderId: "inbound39" }), helpers);
    await echo.processIncomingEcho({ platform: "facebook", pageId: "inbound39", recipientId: SENDER, mid: "echo-39", text: "our reply", timestamp: Date.now() / 1000 }, helpers);
    expect(await events("message.received")).toHaveLength(0);
    expect(await events("comment.received")).toHaveLength(0);
  });

  it("does not emit without the PRO licence", async () => {
    await gate.clearLicense();
    await message.processIncomingMessage(messageJob(), helpers);
    expect(await events("message.received")).toHaveLength(0);
    expect(await db.select().from(s.messages).where(eq(s.messages.conversation_id, CV))).toHaveLength(1);
  });

  it("can be subscribed to explicitly", async () => {
    const res = await webhooks.POST(request("POST", { url: "http://127.0.0.1:9/e", event_types: ["message.received", "comment.received"] }));
    expect(res.status).toBe(201);
  });

  it("serves the message and comment by id, scoped to the workspace", async () => {
    await message.processIncomingMessage(messageJob(), helpers);
    const stored = (await db.select().from(s.messages).where(eq(s.messages.conversation_id, CV)))[0]!;
    const res = await messageRoute.GET(request("GET"), { params: Promise.resolve({ messageId: stored.id }) });
    expect((await res.json()).data).toMatchObject({ id: stored.id, conversation_id: CV, direction: "inbound", text: inbound.rows[0].text });
    await db.update(s.channels).set({ platform: "facebook" }).where(eq(s.channels.id, CH));
    await comment.processIncomingComment(commentJob(1), helpers);
    const logged = (await db.select().from(s.commentLogs).where(eq(s.commentLogs.channel_id, CH)))[0]!;
    const cres = await commentRoute.GET(request("GET"), { params: Promise.resolve({ commentId: logged.id }) });
    expect((await cres.json()).data).toMatchObject({ id: logged.id, post_id: "post-39", comment_text: inbound.rows[1].text });

    const otherKey = "sk_live_inbound_events_other_0123456789";
    await db.insert(s.apiKeys).values({ workspace_id: OTHER, name: "Other", key_hash: createHash("sha256").update(otherKey).digest("hex"), key_prefix: "sk_live_ot" });
    expect((await messageRoute.GET(request("GET", undefined, otherKey), { params: Promise.resolve({ messageId: stored.id }) })).status).toBe(404);
    expect((await commentRoute.GET(request("GET", undefined, otherKey), { params: Promise.resolve({ commentId: logged.id }) })).status).toBe(404);
  });
});
