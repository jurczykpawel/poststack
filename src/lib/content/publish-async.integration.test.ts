import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { runOnce, run } from "graphile-worker";
import type { Hono } from "hono";
import type { Provider } from "@/lib/providers/types";

const { sends } = vi.hoisted(() => ({ sends: vi.fn<Provider["publish"]>(async () => ({ providerHandle: "published-once" })) }));
vi.mock("@/lib/providers", async original => {
  const actual = await original<typeof import("@/lib/providers")>();
  return { ...actual, getProviderForPlatform: (platform: string) => ({ ...actual.getProviderForPlatform(platform), publish: sends }) };
});
vi.mock("@/lib/net/safe-fetch", async original => {
  const actual = await original<typeof import("@/lib/net/safe-fetch")>();
  return { ...actual, safeFetch: async (url: string, init: RequestInit, opts: Parameters<typeof actual.safeFetch>[2]) => {
    await actual.assertSafeUrl(url, opts);
    return fetch(url, { ...init, redirect: "error" });
  } };
});

const TEST_DB = process.env.TEST_DATABASE_URL!;
const key = "sk_live_publish_async_fixture_0123456789abcdef";
const bytes = readFileSync("e2e/fixtures/tiktok-preview.mp4");
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;
let ws: string;
let channelId: string;
let source: Server;
let sourcePort: number;
let lag = 0;
let sourceStatus = 200;
let downloads = 0;
const fetchNative = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { seedWorkspace } = await import("../../../tests/helpers/workspace");
  ws = await seedWorkspace(db, s, { slug: `publish-async-${Date.now()}` });
  const { encryptTokens } = await import("@/lib/crypto");
  const [channel] = await db.insert(s.channels).values({ workspace_id: ws, platform: "instagram", platform_id: "async-publish", connection_mode: "manual_token", token_encrypted: encryptTokens({ access_token: "fixture" }), webhook_secret: "fixture", status: "active" }).returning();
  channelId = channel.id;
  await db.insert(s.apiKeys).values({ workspace_id: ws, name: "publish", key_prefix: "sk_live_publish", key_hash: createHash("sha256").update(key).digest("hex"), scopes: ["posts:write"] });
  app = (await import("@/server/app")).buildApp();
  source = createServer((_req, res) => {
    downloads++;
    setTimeout(() => { res.writeHead(sourceStatus, { "content-type": "video/mp4" }); res.end(bytes); }, lag);
  });
  await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
  sourcePort = (source.address() as { port: number }).port;
});
beforeEach(async () => {
  sends.mockClear(); lag = 0; sourceStatus = 200; downloads = 0;
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  await db.delete(s.posts).where(eq(s.posts.workspace_id, ws));
  await db.delete(s.deliveries).where(eq(s.deliveries.workspace_id, ws));
  await db.delete(s.media).where(eq(s.media.workspace_id, ws));
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => fetchNative(`http://127.0.0.1:${sourcePort}/video`, init));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  await new Promise<void>(resolve => source.close(() => resolve()));
  await db.execute(sql`truncate graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await (await import("@/lib/queue/client")).closeQueue();
  await db.$client.end();
});
async function publish(when = "now", url = "https://example.com/editorial.mp4") {
  const [post] = await db.insert(s.posts).values({ workspace_id: ws, platform: "instagram", video_url: url, description: "Ready for publication", status: "planned" }).returning();
  const response = await app.request(`/api/v1/posts/${post.id}/publish`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ channelId, when }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["data", "error"]);
  expect(Object.keys(body.data).sort()).toEqual(["delivery", "post"]);
  expect(body.error).toBeNull();
  expect(body.data.post.deliveryId).toBe(body.data.delivery.id);
  return body.data.delivery as { id: string; payload: { media: { mediaId: string }[] } };
}
async function tasks() { return (await import("@/lib/queue/tasks")).createTaskList(); }
async function drain(task: "publish" | "media-ingest") {
  await runOnce({ connectionString: TEST_DB, taskList: { [task]: (await tasks())[task] } });
}
const delivery = (id: string) => db.query.deliveries.findFirst({ where: and(eq(s.deliveries.id, id), eq(s.deliveries.workspace_id, ws)) });
async function due(id: string) { await db.execute(sql`update graphile_worker._private_jobs set run_at=now() where key=${`publish:${id}`}`); }

describe("editorial publish waits for remote media", () => {
  it("returns within two seconds for a 20-second HTTP source, defers without an attempt, and publishes once", async () => {
    lag = 20_000;
    const start = Date.now();
    const d = await publish();
    expect(Date.now() - start).toBeLessThan(2000);
    expect(downloads).toBe(0);
    await drain("publish");
    expect(sends).not.toHaveBeenCalled();
    expect(await delivery(d.id)).toMatchObject({ status: "scheduled", attempts: 0, attempt_started_at: null });
    const job = await db.execute(sql`select attempts,run_at from graphile_worker.jobs where key=${`publish:${d.id}`}`);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0].attempts).toBe(0);
    expect(new Date(job.rows[0].run_at as string).getTime()).toBeGreaterThan(Date.now());
    await drain("media-ingest");
    await drain("publish");
    await drain("publish");
    expect(await delivery(d.id)).toMatchObject({ status: "sent", attempts: 1 });
    expect(downloads).toBe(1);
    expect(sends).toHaveBeenCalledOnce();
    expect(sends.mock.calls[0][0]).toMatchObject({ request: { caption: "Ready for publication" }, mediaDurationsSec: [1] });
    expect(sends.mock.calls[0][0].mediaUrls[0]).toContain(createHash("sha256").update(bytes).digest("hex"));
  });

  it("turns a failed source into a failed delivery with its reason and no provider call", async () => {
    sourceStatus = 503;
    const d = await publish();
    await drain("publish");
    await drain("media-ingest");
    await due(d.id);
    await drain("publish");
    expect(await delivery(d.id)).toMatchObject({ status: "failed", attempts: 1, last_error: expect.stringContaining("503") });
    expect((await db.query.posts.findFirst({ where: eq(s.posts.delivery_id, d.id) }))?.status).toBe("failed");
    expect(sends).not.toHaveBeenCalled();
  });

  it("keeps the future schedule while ingesting and never sends before that time", async () => {
    const at = Date.now() + 5000;
    const d = await publish(new Date(at).toISOString());
    // Exercise an early wakeup too: waiting for media must retain the future lower bound.
    await due(d.id);
    await drain("publish");
    const queued = await db.execute(sql`select run_at from graphile_worker.jobs where key=${`publish:${d.id}`}`);
    expect(new Date(queued.rows[0].run_at as string).getTime()).toBeGreaterThanOrEqual(at);
    await drain("media-ingest");
    expect(sends).not.toHaveBeenCalled();
    let sentAt = 0;
    sends.mockImplementationOnce(async () => { sentAt = Date.now(); return { providerHandle: "scheduled-once" }; });
    const runner = await run({ connectionString: TEST_DB, pollInterval: 50, taskList: { publish: (await tasks()).publish } });
    try { await expect.poll(async () => (await delivery(d.id))?.status, { timeout: 15_000 }).toBe("sent"); }
    finally { await runner.stop(); }
    expect(sentAt).toBeGreaterThanOrEqual(at);
    expect(sends).toHaveBeenCalledOnce();
    expect((await delivery(d.id))?.scheduled_at.getTime()).toBe(at);
  });

  it("waits for media introduced by an edit between the preflight and the claim", async () => {
    const url = "https://example.com/original.mp4";
    await db.insert(s.media).values({ workspace_id: ws, checksum: "original", storage_key: "original", url, kind: "video" });
    const d = await publish("now", url);
    const { enqueueIngest } = await import("@/lib/media/async-ingest");
    const pending = await enqueueIngest("https://example.com/replacement.mp4", ws);
    const resolver = await import("@/lib/deliveries/resolve-media");
    const original = resolver.resolveMediaDetails;
    vi.spyOn(resolver, "resolveMediaDetails").mockImplementationOnce(async (...args) => {
      const details = await original(...args);
      await db.update(s.deliveries).set({ payload: { ...d.payload, media: [{ mediaId: pending.id }] } }).where(eq(s.deliveries.id, d.id));
      return details;
    });
    await drain("publish");
    expect(sends).not.toHaveBeenCalled();
    expect(await delivery(d.id)).toMatchObject({ status: "scheduled", attempts: 0, attempt_started_at: null });
    await drain("media-ingest");
    await due(d.id);
    await drain("publish");
    expect(sends).toHaveBeenCalledOnce();
    expect(sends.mock.calls[0][0].mediaUrls[0]).not.toBe(url);
    expect(sends.mock.calls[0][0].request.media).toEqual([{ mediaId: pending.id }]);
  });

  it("reuses already-registered media without fetching or enqueuing ingestion", async () => {
    const url = "https://example.com/already.mp4";
    const [media] = await db.insert(s.media).values({ workspace_id: ws, checksum: "already", storage_key: "existing", url, kind: "video", duration_sec: 1 }).returning();
    const d = await publish("now", url);
    expect(d.payload.media).toEqual([{ mediaId: media.id }]);
    await drain("media-ingest");
    await drain("publish");
    expect(downloads).toBe(0);
    expect(sends).toHaveBeenCalledOnce();
  });
});
