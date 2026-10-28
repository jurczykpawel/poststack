import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import recording from "../../../tests/fixtures/inbox/lifecycle.json";
import inbound from "../../../tests/fixtures/inbox/inbound.json";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "c0ffee17-0000-4000-8000-000000000001";
const OTHER = "c0ffee17-0000-4000-8000-000000000002";
const MEMBER = "c0ffee17-0000-4000-8000-000000000003";
const KEY = "sk_live_inbox_lifecycle_contract_0123456789";
const CT = recording.contact.id;
const CH = recording.contact.contact_channels[0].channel.id;
const CV = recording.conversation.id;
const helpers = {} as JobHelpers;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let contact: typeof import("@/server/handlers/v1/contacts/[contactId]/route");
let conversation: typeof import("@/server/handlers/v1/conversations/[conversationId]/route");
let webhooks: typeof import("@/server/handlers/v1/webhooks/route");
let webhook: typeof import("@/server/handlers/v1/webhooks/[webhookId]/route");
let dispatch: typeof import("./dispatch");
let queue: typeof import("@/lib/queue/client");
let verify: typeof import("./signature").verifyWebhook;
let processIncomingMessage: typeof import("@/lib/workers/incoming-message-worker").processIncomingMessage;
let processIncomingComment: typeof import("@/lib/workers/incoming-comment-worker").processIncomingComment;
let resolveContactConversation: typeof import("@/lib/workers/resolve-contact").resolveContactConversation;
let server: Server;
let url: string;
const received: { body: string; signature: string; type: string }[] = [];

const request = (method: string, body?: unknown) => new Request("http://local/api/v1", {
  method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const contactCtx = { params: Promise.resolve({ contactId: CT }) };
const convCtx = { params: Promise.resolve({ conversationId: CV }) };
const patch = (body: unknown) => conversation.PATCH(request("PATCH", body), convCtx);
const events = (type: string) => db.select().from(s.events).where(and(eq(s.events.workspace_id, WS), eq(s.events.type, type)));

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
  contact = await import("@/server/handlers/v1/contacts/[contactId]/route");
  conversation = await import("@/server/handlers/v1/conversations/[conversationId]/route");
  webhooks = await import("@/server/handlers/v1/webhooks/route");
  webhook = await import("@/server/handlers/v1/webhooks/[webhookId]/route");
  dispatch = await import("./dispatch");
  queue = await import("@/lib/queue/client");
  ({ verifyWebhook: verify } = await import("./signature"));
  ({ processIncomingMessage } = await import("@/lib/workers/incoming-message-worker"));
  ({ processIncomingComment } = await import("@/lib/workers/incoming-comment-worker"));
  ({ resolveContactConversation } = await import("@/lib/workers/resolve-contact"));
  await licenseInstance();
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body, signature: String(req.headers["x-poststack-signature"]), type: String(req.headers["x-poststack-event"]) });
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Receiver did not start");
  url = `http://127.0.0.1:${address.port}/events`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  received.length = 0;
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  for (const id of [WS, OTHER]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
    await db.insert(s.workspaces).values({ id, name: "Lifecycle", slug: `lifecycle-${id}` });
  }
  await db.delete(s.users).where(eq(s.users.id, MEMBER));
  await db.insert(s.users).values({ id: MEMBER, email: "lifecycle@example.test" });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: MEMBER });
  const channel = recording.contact.contact_channels[0];
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "lifecycle", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.contacts).values({ id: CT, workspace_id: WS, display_name: recording.contact.display_name });
  await db.insert(s.contactChannels).values({ contact_id: CT, channel_id: CH, platform_sender_id: channel.platform_sender_id });
  await db.insert(s.conversations).values({ id: CV, workspace_id: WS, channel_id: CH, contact_id: CT, platform: "instagram", status: "open" });
  await db.insert(s.apiKeys).values({ workspace_id: WS, name: "Lifecycle", key_hash: createHash("sha256").update(KEY).digest("hex"), key_prefix: "sk_live_lc" });
});

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!TEST_DB) return;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  for (const id of [WS, OTHER]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.delete(s.users).where(eq(s.users.id, MEMBER));
  await db.delete(s.instanceLicense);
  await queue.closeQueue();
  await db.$client.end();
  vi.unstubAllEnvs();
});

async function subscribe(event_types: string[]) {
  const response = await webhooks.POST(request("POST", { url, event_types }));
  expect(response.status).toBe(201);
  return (await response.json()).data as { id: string; secret: string };
}

async function deliver(type: string) {
  const rows = await events(type);
  expect(rows).toHaveLength(1);
  const event = rows[0];
  const jobs = await db.execute(sql`select payload from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id where t.identifier = 'event-dispatch' and payload->>'eventId' = ${event.id}`);
  expect(jobs.rows).toHaveLength(1);
  await dispatch.processEventDispatch({ eventId: event.id }, helpers);
  const deliveries = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.event_id, event.id));
  for (const d of deliveries) await dispatch.processWebhookDelivery({ deliveryId: d.id }, helpers);
  return received.map((r) => JSON.parse(r.body));
}

describe.skipIf(!TEST_DB)("contact and conversation receiver contracts", () => {
  const workerHelpers = { logger: { info() {} }, job: { attempts: 1, max_attempts: 3 } } as unknown as JobHelpers;
  const messageJob = (index = 0) => ({
    platform: "instagram", pageId: "lifecycle", senderId: recording.contact.contact_channels[0].platform_sender_id,
    recipientId: "lifecycle", mid: inbound.rows[index].platform_message_id,
    text: inbound.rows[index].text, timestamp: Date.parse(inbound.rows[index].created_at) / 1000,
  });

  it.each(["closed", "snoozed"] as const)("delivers one %s-to-open transition for a fresh inbound, and none for duplicates or open-to-open", async (status) => {
    await subscribe(["conversation.updated"]);
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await db.update(s.conversations).set({ status }).where(eq(s.conversations.id, CV));
    await processIncomingMessage(messageJob(), workerHelpers);
    const [body] = await deliver("conversation.updated");
    expect(body.data).toMatchObject({
      conversationId: CV, workspaceId: WS, contactId: CT, channelId: CH,
      previous: { status, is_automation_paused: false, assigned_to: null },
      current: { status: "open", is_automation_paused: false, assigned_to: null },
    });
    await processIncomingMessage(messageJob(), workerHelpers);
    await processIncomingMessage(messageJob(1), workerHelpers);
    expect(await events("conversation.updated")).toHaveLength(1);
  });

  it("does not reopen or emit for an older inbound or a repeated inbound after closure", async () => {
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await processIncomingMessage(messageJob(), workerHelpers);
    await db.update(s.conversations).set({ status: "closed", last_message_at: new Date() }).where(eq(s.conversations.id, CV));
    await processIncomingMessage(messageJob(), workerHelpers);
    await processIncomingMessage(messageJob(1), workerHelpers);
    expect(await events("conversation.updated")).toHaveLength(0);
    expect((await db.query.conversations.findFirst({ where: eq(s.conversations.id, CV) }))?.status).toBe("closed");
  });

  it("rolls back the inbound message, counters and reopen when its event cannot be queued", async () => {
    await db.update(s.channels).set({ status: "paused" }).where(eq(s.channels.id, CH));
    await db.update(s.conversations).set({ status: "closed" }).where(eq(s.conversations.id, CV));
    vi.spyOn(queue, "addJobTx").mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(processIncomingMessage(messageJob(), workerHelpers)).rejects.toThrow("Queue unavailable");
    expect((await db.query.conversations.findFirst({ where: eq(s.conversations.id, CV) }))).toMatchObject({ status: "closed", unread_count: 0, last_message_at: null });
    expect(await db.select().from(s.messages).where(eq(s.messages.conversation_id, CV))).toHaveLength(0);
    expect(await events("conversation.updated")).toHaveLength(0);
  });

  it("emits for the resolver's reopen but not its activity-only reaction path", async () => {
    const channel = { id: CH, workspace_id: WS, platform: "instagram" as const };
    const sender = recording.contact.contact_channels[0].platform_sender_id;
    await db.update(s.conversations).set({ status: "snoozed" }).where(eq(s.conversations.id, CV));
    await resolveContactConversation(channel, sender, null, null, { reopenClosed: false });
    expect(await events("conversation.updated")).toHaveLength(0);
    await resolveContactConversation(channel, sender, null, null);
    expect((await events("conversation.updated"))[0]?.payload).toMatchObject({ previous: { status: "snoozed" }, current: { status: "open" } });
    await resolveContactConversation(channel, sender, null, null);
    expect(await events("conversation.updated")).toHaveLength(1);
  });

  it("emits once for a comment reopening its thread, but not a repeated comment or an already open thread", async () => {
    await db.update(s.channels).set({ platform: "facebook", status: "paused" }).where(eq(s.channels.id, CH));
    await db.update(s.conversations).set({ platform: "facebook", thread_type: "comment", status: "closed" }).where(eq(s.conversations.id, CV));
    const job = { platform: "facebook", pageId: "lifecycle", postId: undefined, senderName: undefined, commentId: inbound.rows[0].platform_message_id,
      senderId: recording.contact.contact_channels[0].platform_sender_id, text: inbound.rows[0].text, timestamp: Date.parse(inbound.rows[0].created_at) / 1000 };
    await processIncomingComment(job, workerHelpers);
    expect((await events("conversation.updated"))[0]?.payload).toMatchObject({ conversationId: CV, previous: { status: "closed" }, current: { status: "open" } });
    await processIncomingComment(job, workerHelpers);
    await processIncomingComment({ ...job, commentId: inbound.rows[1].platform_message_id }, workerHelpers);
    expect(await events("conversation.updated")).toHaveLength(1);
  });

  it("accepts both explicit subscriptions on creation and update", async () => {
    const ep = await subscribe(["contact.erased", "conversation.updated"]);
    const response = await webhook.PATCH(request("PATCH", { event_types: ["conversation.updated", "contact.erased"] }), { params: Promise.resolve({ webhookId: ep.id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.event_types).toEqual(["conversation.updated", "contact.erased"]);
  });

  it("lets explicit and wildcard receivers erase their copy after the contact returns 404", async () => {
    const typed = await subscribe(["contact.erased"]);
    const all = await subscribe([]);
    await subscribe(["conversation.updated"]);
    expect((await contact.DELETE(request("DELETE"), contactCtx)).status).toBe(204);
    expect((await contact.GET(request("GET"), contactCtx)).status).toBe(404);
    const bodies = await deliver("contact.erased");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ type: "contact.erased", data: {
        id: CT, type: "contact", workspaceId: WS,
        channels: [{ channelId: CH, platform: "instagram", platformSenderId: recording.contact.contact_channels[0].platform_sender_id }],
      } });
      expect(Number.isNaN(Date.parse(body.created_at))).toBe(false);
      expect(body.id).toBeTruthy();
    }
    for (const receipt of received) {
      expect(receipt.type).toBe("contact.erased");
      expect(verify(typed.secret, receipt.signature, receipt.body) || verify(all.secret, receipt.signature, receipt.body)).toBe(true);
    }
    expect((await contact.DELETE(request("DELETE"), contactCtx)).status).toBe(404);
    expect(await events("contact.erased")).toHaveLength(1);
  });

  it("still identifies a contact without any remaining channel links", async () => {
    await db.delete(s.contactChannels).where(eq(s.contactChannels.contact_id, CT));
    await contact.DELETE(request("DELETE"), contactCtx);
    expect((await events("contact.erased"))[0]?.payload).toMatchObject({ workspaceId: WS, channels: [] });
  });

  it("retains every linked platform identity after erasure", async () => {
    const channelId = "c0ffee17-0000-4000-8000-000000000004";
    await db.insert(s.channels).values({ id: channelId, workspace_id: WS, platform: "facebook", platform_id: "lifecycle-other", token_encrypted: "x", webhook_secret: "s" });
    await db.insert(s.contactChannels).values({ contact_id: CT, channel_id: channelId, platform_sender_id: "second-identity" });
    await contact.DELETE(request("DELETE"), contactCtx);
    const payload = (await events("contact.erased"))[0]?.payload as { channels: unknown[] };
    expect(payload.channels).toHaveLength(2);
    expect(payload.channels).toEqual(expect.arrayContaining([
      { channelId: CH, platform: "instagram", platformSenderId: recording.contact.contact_channels[0].platform_sender_id },
      { channelId, platform: "facebook", platformSenderId: "second-identity" },
    ]));
  });

  it("emits one erasure when two deletion requests arrive together", async () => {
    const responses = await Promise.all([contact.DELETE(request("DELETE"), contactCtx), contact.DELETE(request("DELETE"), contactCtx)]);
    expect(responses.map((r) => r.status).sort()).toEqual([204, 404]);
    expect(await events("contact.erased")).toHaveLength(1);
  });

  it("lets the receiver apply state changes without fetching the current conversation", async () => {
    const ep = await subscribe(["conversation.updated"]);
    const all = await subscribe([]);
    expect((await patch({ status: recording.closed.status, is_automation_paused: true, assigned_to: MEMBER })).status).toBe(200);
    const bodies = await deliver("conversation.updated");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ type: "conversation.updated", data: {
      id: CV, type: "conversation", workspaceId: WS, conversationId: CV, contactId: CT, channelId: CH,
      previous: { status: recording.conversation.status, is_automation_paused: false, assigned_to: null },
      current: { status: "closed", is_automation_paused: true, assigned_to: MEMBER },
    } });
    expect(Number.isNaN(Date.parse(bodies[0].data.updatedAt))).toBe(false);
    const stored = await db.query.conversations.findFirst({ where: and(eq(s.conversations.id, CV), eq(s.conversations.workspace_id, WS)) });
    expect(bodies[0].data.updatedAt).toBe(stored?.updated_at.toISOString());
    for (const receipt of received) {
      expect(receipt.type).toBe("conversation.updated");
      expect(verify(ep.secret, receipt.signature, receipt.body) || verify(all.secret, receipt.signature, receipt.body)).toBe(true);
    }
  });

  it("records snooze, reopen, pause, resume, assign and unassign as actual transitions", async () => {
    let state = { status: "open", is_automation_paused: false, assigned_to: null as string | null };
    const expected = [];
    for (const body of [{ status: "snoozed" }, { status: "open" }, { is_automation_paused: true }, { is_automation_paused: false }, { assigned_to: MEMBER }, { assigned_to: null }]) {
      expect((await patch(body)).status).toBe(200);
      const current = { ...state, ...body };
      expected.push(expect.objectContaining({ previous: state, current }));
      state = current;
    }
    const rows = await events("conversation.updated");
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.payload)).toEqual(expect.arrayContaining(expected));
  });

  it("does not emit for a read receipt, unchanged fields, rejected assignment or another workspace", async () => {
    expect((await patch({ unread_count: 0 })).status).toBe(200);
    expect((await patch({ status: "open", is_automation_paused: false, assigned_to: null })).status).toBe(200);
    expect((await patch({ assigned_to: OTHER })).status).toBe(422);
    await db.update(s.apiKeys).set({ workspace_id: OTHER }).where(eq(s.apiKeys.workspace_id, WS));
    expect((await patch({ status: "closed" })).status).toBe(404);
    expect((await contact.DELETE(request("DELETE"), contactCtx)).status).toBe(404);
    expect(await events("conversation.updated")).toHaveLength(0);
    expect(await events("contact.erased")).toHaveLength(0);
  });

  it.each(["contact", "conversation"])("rolls back the %s mutation and event when dispatch cannot be enqueued", async (kind) => {
    vi.spyOn(queue, "addJobTx").mockRejectedValueOnce(new Error("Queue unavailable"));
    await expect(kind === "contact" ? contact.DELETE(request("DELETE"), contactCtx) : patch({ status: "closed" })).rejects.toThrow("Queue unavailable");
    expect((await db.query.contacts.findFirst({ where: eq(s.contacts.id, CT) }))?.id).toBe(CT);
    expect((await db.query.conversations.findFirst({ where: eq(s.conversations.id, CV) }))?.status).toBe("open");
    expect(await events(kind === "contact" ? "contact.erased" : "conversation.updated")).toHaveLength(0);
    expect((await db.select().from(s.contactChannels).where(eq(s.contactChannels.contact_id, CT)))).toHaveLength(1);
  });

  it("serializes concurrent conversation changes into a continuous state history", async () => {
    await Promise.all([patch({ status: "closed" }), patch({ is_automation_paused: true })]);
    const payloads = (await events("conversation.updated")).map((r) => r.payload as {
      previous: { status: string; is_automation_paused: boolean; assigned_to: string | null };
      current: { status: string; is_automation_paused: boolean; assigned_to: string | null };
    });
    expect(payloads).toHaveLength(2);
    const first = payloads.find((p) => p.previous.status === "open" && !p.previous.is_automation_paused);
    const second = payloads.find((p) => p !== first);
    const initial = { status: "open", assigned_to: null, is_automation_paused: false };
    expect(first?.previous).toEqual(initial);
    expect(second?.previous).toEqual(first?.current);
    expect(second?.current).toMatchObject({ status: "closed", is_automation_paused: true });
  });
});
