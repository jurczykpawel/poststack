import recordedWebhook from "../../../tests/fixtures/webhook-consumer.json";
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Hermetic DNS for the SSRF guard: a host with "private" in it resolves to an RFC1918 address; every
// other fake delivery host resolves to a public IP. Lets a test pick which IP category the webhook
// policy will classify (and thus allow/refuse) without any real DNS.
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) =>
    host.includes("private") ? [{ address: "10.0.0.5" }] : [{ address: "93.184.216.34" }],
}));

// Deterministic transport for the secure-by-default webhook guard. dispatch now delivers via
// safeFetchWebhook → @/lib/net/safe-fetch's `safeFetch`, which (unlike the old media guard) connects
// over node:http/https rather than global fetch. We keep the REAL policy (`assertSafeUrl`, run with
// the real webhookAllow() set) so secure-by-default is exercised for real, but swap the pinned
// connector for a controllable stub so no socket is ever opened. A refused target throws in
// assertSafeUrl BEFORE the stub is reached, so the stub is never called on the SSRF path.
const { connectStub } = vi.hoisted(() => ({ connectStub: vi.fn<(url: string, init: RequestInit) => Promise<Response>>() }));
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/net/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string, init: RequestInit, opts: Parameters<typeof actual.safeFetch>[2]) => {
      await actual.assertSafeUrl(url, opts); // REAL secure-by-default policy (public-only unless flag)
      return connectStub(url, init);
    },
  };
});

import type { JobHelpers } from "graphile-worker";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let svc: typeof import("./endpoints");
let emitEvent: typeof import("@/lib/events").emitEvent;
let processEventDispatch: typeof import("./dispatch").processEventDispatch;
let processWebhookDelivery: typeof import("./dispatch").processWebhookDelivery;
let verifyWebhook: typeof import("./signature").verifyWebhook;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "c0ffee03-0000-4000-8000-000000000f01";
const OTHER_WS = "c0ffee03-0000-4000-8000-000000000f02";

const helpers = (attempts = 1, max = 8) =>
  ({ logger: { info() {}, error() {} }, job: { attempts, max_attempts: max } }) as unknown as JobHelpers;

async function jobs(task: string): Promise<number> {
  const r = await db.execute(
    sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = ${task}`,
  );
  return Number((r.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  svc = await import("./endpoints");
  ({ emitEvent } = await import("@/lib/events"));
  ({ processEventDispatch, processWebhookDelivery } = await import("./dispatch"));
  ({ verifyWebhook } = await import("./signature"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  // Ensure the graphile_worker schema exists before beforeEach truncates its jobs table.
  const { makeWorkerUtils } = await import("graphile-worker");
  const u = await makeWorkerUtils({ connectionString: process.env.DATABASE_URL! });
  await u.migrate();
  await u.release();
});

beforeEach(async () => {
  connectStub.mockReset();
  connectStub.mockResolvedValue(new Response(null, { status: 200 })); // default: a 2xx receiver
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  for (const ws of [WS, OTHER_WS]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
    await seedWorkspace(db, s, { id: ws, slug: `wd-${ws}` });
  }
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await closeQueue();
  await db.$client.end();
});

async function emitNow(
  ws: string,
  type: string,
  payload: Record<string, unknown> = {},
  subject?: { type: string; id: string },
) {
  const [e] = await db
    .insert(s.events)
    .values({ workspace_id: ws, type, payload, subject_type: subject?.type ?? null, subject_id: subject?.id ?? null })
    .returning({ id: s.events.id });
  return e!.id;
}

describe.skipIf(!TEST_DB)("event dispatch + webhook delivery", () => {
  it("fans an event out to a matching active endpoint (one delivery, enqueued once)", async () => {
    await svc.createEndpoint(WS, { url: "https://hook.test/x", eventTypes: ["post.published"] });
    const eventId = await emitNow(WS, "post.published", { id: "p1" });
    const before = await jobs("webhook-delivery");
    await processEventDispatch({ eventId }, helpers());
    expect(await jobs("webhook-delivery")).toBe(before + 1);
    const d = await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.event_id, eventId) });
    expect(d!.status).toBe("pending");
    expect(d!.workspace_id).toBe(WS);
  });

  it("respects event-type filtering (empty subscribes to all; a typed list filters)", async () => {
    await svc.createEndpoint(WS, { url: "https://hook.test/typed", eventTypes: ["post.failed"] });
    const published = await emitNow(WS, "post.published");
    await processEventDispatch({ eventId: published }, helpers());
    expect(await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.event_id, published) })).toBeUndefined();
    const failed = await emitNow(WS, "post.failed");
    await processEventDispatch({ eventId: failed }, helpers());
    expect(await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.event_id, failed) })).toBeTruthy();
  });

  it("does not dispatch to an inactive endpoint", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.test/off" });
    await svc.updateEndpoint(WS, ep.id, { active: false });
    const eventId = await emitNow(WS, "post.published");
    const before = await jobs("webhook-delivery");
    await processEventDispatch({ eventId }, helpers());
    expect(await jobs("webhook-delivery")).toBe(before);
  });

  it("is tenant-isolated: an endpoint never receives another workspace's event", async () => {
    await svc.createEndpoint(WS, { url: "https://hook.test/mine", eventTypes: [] });
    const otherEvent = await emitNow(OTHER_WS, "post.published");
    const before = await jobs("webhook-delivery");
    await processEventDispatch({ eventId: otherEvent }, helpers());
    expect(await jobs("webhook-delivery")).toBe(before);
    expect(await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.event_id, otherEvent) })).toBeUndefined();
  });

  it("delivery signs + POSTs; 2xx -> delivered with a verifiable signature and a correlatable subject", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.test/x", eventTypes: [] });
    const SUBJECT = "c0ffee03-0000-4000-8000-0000000000aa";
    const eventId = await emitNow(WS, "post.published", { platform: "facebook" }, { type: "post", id: SUBJECT });
    const [d] = await db
      .insert(s.webhookDeliveries)
      .values({ workspace_id: WS, event_id: eventId, endpoint_id: ep.id })
      .returning({ id: s.webhookDeliveries.id });
    let seen: { body: string; sig: string } | null = null;
    connectStub.mockImplementation(async (_u: string, init: RequestInit) => {
      seen = {
        body: String(init.body),
        sig: (init.headers as Record<string, string>)["X-PostStack-Signature"] ?? "",
      };
      return new Response(null, { status: 200 });
    });
    await processWebhookDelivery({ deliveryId: d!.id }, helpers());
    const after = await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.id, d!.id) });
    expect(after!.status).toBe("delivered");
    expect(after!.attempts).toBe(1);
    expect(after!.http_status).toBe(200);
    expect(verifyWebhook(ep.secret, seen!.sig, seen!.body)).toBe(true);
    // The body is the event envelope; data carries the subject (so a receiver can GET the resource).
    const parsed = JSON.parse(seen!.body) as { type: string; data: { id: string; type: string; platform: string } };
    expect(parsed.type).toBe("post.published");
    expect(parsed.data.id).toBe(SUBJECT);
    expect(parsed.data.type).toBe("post");
    expect(parsed.data.platform).toBe("facebook"); // event payload merged in
  });

  it("merges custom headers into the delivery, without letting them override the signature/event/timestamp/content-type headers", async () => {
    const ep = await svc.createEndpoint(WS, {
      url: "https://hook.test/hdr",
      eventTypes: [],
      headers: { Authorization: "Bearer secret123", "X-PostStack-Event": "spoofed", "content-type": "text/plain" },
    });
    const eventId = await emitNow(WS, "post.published");
    const [d] = await db
      .insert(s.webhookDeliveries)
      .values({ workspace_id: WS, event_id: eventId, endpoint_id: ep.id })
      .returning({ id: s.webhookDeliveries.id });
    let seenHeaders: Record<string, string> | null = null;
    connectStub.mockImplementation(async (_u: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    });
    await processWebhookDelivery({ deliveryId: d!.id }, helpers());
    expect(seenHeaders!.Authorization).toBe("Bearer secret123");
    expect(seenHeaders!["X-PostStack-Event"]).toBe("post.published"); // reserved header wins over the custom one
    expect(seenHeaders!["content-type"]).toBe("application/json"); // reserved header wins
  });

  it("merges extra payload fields into the delivered body, with {{placeholder}} substitution from the event envelope, and keeps the signature valid for the actual sent body", async () => {
    const ep = await svc.createEndpoint(WS, {
      url: "https://hook.test/extra",
      eventTypes: [],
      extraFields: { source: "poststack", note: "event {{type}} / {{id}}" },
    });
    const eventId = await emitNow(WS, "post.published");
    const [d] = await db
      .insert(s.webhookDeliveries)
      .values({ workspace_id: WS, event_id: eventId, endpoint_id: ep.id })
      .returning({ id: s.webhookDeliveries.id });
    let seen: { body: string; sig: string } | null = null;
    connectStub.mockImplementation(async (_u: string, init: RequestInit) => {
      seen = { body: String(init.body), sig: (init.headers as Record<string, string>)["X-PostStack-Signature"] ?? "" };
      return new Response(null, { status: 200 });
    });
    await processWebhookDelivery({ deliveryId: d!.id }, helpers());
    expect(verifyWebhook(ep.secret, seen!.sig, seen!.body)).toBe(true); // signature covers the FINAL (customized) body
    const parsed = JSON.parse(seen!.body) as { type: string; id: string; source: string; note: string };
    expect(parsed.source).toBe("poststack");
    expect(parsed.note).toBe(`event post.published / ${eventId}`);
    expect(parsed.type).toBe("post.published"); // standard fields still present (extra fields only add/override)
  });

  it("clears the previous HTTP code when a later attempt has no response", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.test/x" });
    const eventId = await emitNow(WS, "post.failed");
    const [d] = await db.insert(s.webhookDeliveries).values({ workspace_id: WS, endpoint_id: ep.id, event_id: eventId }).returning();
    connectStub.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(processWebhookDelivery({ deliveryId: d.id }, helpers())).rejects.toThrow("HTTP 503");
    expect((await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.id, d.id) }))!.http_status).toBe(503);
    connectStub.mockRejectedValueOnce(new Error("Connection timed out"));
    await expect(processWebhookDelivery({ deliveryId: d.id }, helpers(2))).rejects.toThrow("Connection timed out");
    const result = await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.id, d.id) });
    expect(result).toMatchObject({ attempts: 2, http_status: null, last_error: "Connection timed out" });
  });

  it("non-2xx -> throws (retry); marks failed on the final attempt", async () => {
    const ep = await svc.createEndpoint(WS, { url: "https://hook.test/x", eventTypes: [] });
    const eventId = await emitNow(WS, "post.failed");
    const [d] = await db
      .insert(s.webhookDeliveries)
      .values({ workspace_id: WS, event_id: eventId, endpoint_id: ep.id })
      .returning({ id: s.webhookDeliveries.id });
    connectStub.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(processWebhookDelivery({ deliveryId: d!.id }, helpers(8, 8))).rejects.toThrow();
    const after = await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.id, d!.id) });
    expect(after!.status).toBe("failed");
    expect(after!.http_status).toBe(500);
  });

  it("refuses a private-resolving endpoint (secure-by-default: WEBHOOK_ALLOW_PRIVATE_TARGETS off) -> failed, never connects", async () => {
    // The host contains "private" so the hermetic resolver maps it to 10.0.0.5 (RFC1918). With the
    // flag unset (default), webhookAllow() = {public} only, so assertSafeUrl throws SsrfError before
    // any connection — the delivery dead-letters on its final attempt and the connector is never hit.
    // (With WEBHOOK_ALLOW_PRIVATE_TARGETS=true a self-host operator would allow private/loopback/cgnat
    // and this same target would reach the connector — see safe-target.test.ts for the flag-ON policy.)
    const ep = await svc.createEndpoint(WS, { url: "https://private.internal.example/hook", eventTypes: [] });
    const eventId = await emitNow(WS, "post.published");
    const [d] = await db
      .insert(s.webhookDeliveries)
      .values({ workspace_id: WS, event_id: eventId, endpoint_id: ep.id })
      .returning({ id: s.webhookDeliveries.id });
    await expect(processWebhookDelivery({ deliveryId: d!.id }, helpers(8, 8))).rejects.toThrow(/refused/);
    const after = await db.query.webhookDeliveries.findFirst({ where: eq(s.webhookDeliveries.id, d!.id) });
    expect(after!.status).toBe("failed");
    expect(after!.last_error).toMatch(/refused/);
    expect(connectStub).not.toHaveBeenCalled(); // SSRF refusal happens before any socket
  });

  it("a re-dispatch of the same event does not double-fan-out to its endpoints", async () => {
    const ep1 = await svc.createEndpoint(WS, { url: "https://hook.test/1", eventTypes: [] });
    const ep2 = await svc.createEndpoint(WS, { url: "https://hook.test/2", eventTypes: [] });
    const eventId = await emitNow(WS, "post.published");
    const before = await jobs("webhook-delivery");
    await processEventDispatch({ eventId }, helpers());
    await processEventDispatch({ eventId }, helpers()); // retry — must be a no-op
    const rows = await db.query.webhookDeliveries.findMany({ where: eq(s.webhookDeliveries.event_id, eventId) });
    expect(rows.map((r) => r.endpoint_id).sort()).toEqual([ep1.id, ep2.id].sort());
    expect(rows.length).toBe(2); // not 4
    expect(await jobs("webhook-delivery")).toBe(before + 2);
  });

  it("emitEvent inserts an event AND enqueues event-dispatch in one tx", async () => {
    const before = await jobs("event-dispatch");
    await db.transaction(async (tx) => {
      await emitEvent(tx, WS, "channel.reconnected", { type: "channel", id: "c9" }, { ok: true });
    });
    expect(await jobs("event-dispatch")).toBe(before + 1);
  });
});

describe.skipIf(!TEST_DB)("webhook consumer routing contract", () => {
  it.each(recordedWebhook.events)("preserves recorded $type fields and supplies routing context", async (recorded) => {
    const { emitPostEvent } = await import("@/lib/deliveries/post-events");
    const ep = await svc.createEndpoint(WS, { url: "https://hook.test/consumer", eventTypes: [recorded.type] });
    const [channel] = await db.insert(s.channels).values({
      workspace_id: WS, platform: recorded.data.platform === "facebook" ? "facebook" : "instagram", platform_id: "consumer-account", token_encrypted: "unused", webhook_secret: "unused",
    }).returning();
    const { id, type, ...legacy } = recorded.data;
    if (recorded.type.startsWith("post.")) {
      const [delivery] = await db.insert(s.deliveries).values({
        id: legacy.deliveryId, workspace_id: WS, channel_id: channel.id, format: "image",
        status: recorded.type === "post.published" ? "sent" : "failed",
        payload: { firstComment: "" }, scheduled_at: new Date(), run_at: new Date(),
      }).returning();
      await db.insert(s.posts).values({ id, workspace_id: WS, platform: "instagram", delivery_id: delivery.id, published_at: new Date(recorded.created_at) });
      await emitPostEvent(WS, recorded.type, delivery.id, legacy);
    } else {
      await db.insert(s.contacts).values({ id, workspace_id: WS });
      await db.insert(s.contactChannels).values({ contact_id: id, channel_id: channel.id, platform_sender_id: recordedWebhook.contactIdentity.platform_sender_id });
      // Emission snapshots only identities visible within the contact's workspace.
      const [other] = await db.insert(s.channels).values({ workspace_id: OTHER_WS, platform: "facebook", platform_id: "other-account", token_encrypted: "unused", webhook_secret: "unused" }).returning();
      await db.insert(s.contactChannels).values({ contact_id: id, channel_id: other.id, platform_sender_id: "other-sender" });
      await db.transaction((tx) => emitEvent(tx, WS, recorded.type, { type, id }, legacy));
    }
    const event = (await db.select().from(s.events).where(eq(s.events.subject_id, id)))[0];
    await processEventDispatch({ eventId: event.id }, helpers());
    const [delivery] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.event_id, event.id));
    await processWebhookDelivery({ deliveryId: delivery.id }, helpers());
    const init = connectStub.mock.calls[0][1];
    const raw = String(init.body);
    const body = JSON.parse(raw);
    expect(verifyWebhook(ep.secret, (init.headers as Record<string, string>)["X-PostStack-Signature"], raw)).toBe(true);
    expect(body).toMatchObject({ id: event.id, type: recorded.type, created_at: expect.any(String), data: recorded.data });
    expect(body.data.workspaceId).toBe(WS);
    if (recorded.type.startsWith("post.")) {
      expect(body.data).toMatchObject({ channelId: channel.id, platform: channel.platform, status: recorded.type === "post.published" ? "published" : "failed" });
      if (recorded.type === "post.published") expect(body.data).toMatchObject({ publishedAt: recorded.created_at, firstComment: { status: "not_attempted", reason: "no_text", commentId: null } });
      else expect(body.data.reason).toBe(legacy.error);
    } else {
      expect(body.data.channels).toEqual([{ channelId: channel.id, platform: "instagram", platformSenderId: recordedWebhook.contactIdentity.platform_sender_id }]);
      expect(body.data).not.toHaveProperty("email");
      expect(body.data).not.toHaveProperty("phone");
    }
  });
});
