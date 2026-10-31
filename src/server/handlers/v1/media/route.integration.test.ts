import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Media/provider fetches now connect over the net core's node:http(s) pinned connector (NOT global
// fetch). Keep the REAL SSRF policy (assertSafeUrl: DNS resolve + classify + pin) and route only the
// transport to the global fetch stub these tests install — mock transport, keep policy.
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/net/safe-fetch")>();
  return {
    ...actual,
    safeFetch: async (url: string, init: RequestInit, opts: Parameters<typeof actual.safeFetch>[2]) => {
      await actual.assertSafeUrl(url, opts); // real policy: refuse non-public BEFORE any transport
      return fetch(url, { ...init, redirect: "error" }); // transport via the test's global fetch stub
    },
  };
});

import { createHash } from "crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { runOnce } from "graphile-worker";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

// POST /api/v1/media reference fast-path: when sha256+mime+kind are supplied, an object already in the
// shared CAS bucket is LINKED with no outbound fetch (registerKnownMedia); on not_present it falls back
// to a remote ingestion job. The route's getStorage() returns the process-global InMemoryStorage
// singleton in tests, so seeding it via getStorage().putBytes makes the route's HEAD hit.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let app: Hono;
let casKey: typeof import("@/lib/media/cas").casKey;
let getStorage: typeof import("@/lib/storage").getStorage;
let resetStorage: typeof import("@/lib/storage").__resetStorage;
let WS = "";
const RAW_KEY = "sk_live_media_fastpath_key_0123456789abcd";
const WRITE_KEY = "sk_live_media_write_key_0123456789abcde";
const UNRELATED_KEY = "sk_live_media_unrelated_0123456789abcdef";
const SHA = "c".repeat(64);
// Minimal ftyp/mp42 header so the fallback probe accepts the body as a video.
const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  const { seedWorkspace } = await import("../../../../../tests/helpers/workspace");
  const { buildApp } = await import("../../../app");
  ({ casKey } = await import("@/lib/media/cas"));
  const storage = await import("@/lib/storage");
  getStorage = storage.getStorage;
  resetStorage = storage.__resetStorage;
  app = buildApp();
  WS = await seedWorkspace(db, schema, { slug: `media-route-${Date.now()}` });
  await db.insert(schema.apiKeys).values([
    {
      workspace_id: WS,
      name: "media",
      key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
      key_prefix: RAW_KEY.slice(0, 16),
    },
    {
      workspace_id: WS,
      name: "media-writer",
      key_hash: createHash("sha256").update(WRITE_KEY).digest("hex"),
      key_prefix: WRITE_KEY.slice(0, 16),
      scopes: ["media:write"],
    },
    {
      workspace_id: WS,
      name: "media-unrelated",
      key_hash: createHash("sha256").update(UNRELATED_KEY).digest("hex"),
      key_prefix: UNRELATED_KEY.slice(0, 16),
      scopes: ["stats:read"],
    },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await (await import("@/lib/queue/client")).closeQueue();
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  resetStorage();
});
afterEach(() => vi.unstubAllGlobals());

const auth = { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" };
const post = (body: unknown, key = RAW_KEY) =>
  app.request("/api/v1/media", {
    method: "POST",
    headers: { ...auth, authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

describe("POST /api/v1/media — sha256 reference fast-path", () => {
  it("requires media:write before validating the request", async () => {
    if (!TEST_DB) return;
    expect((await post({}, UNRELATED_KEY)).status).toBe(403);
    expect((await post({}, WRITE_KEY)).status).toBe(422);
  });

  it("links an already-stored object by reference WITHOUT fetching the source URL", async () => {
    if (!TEST_DB) return;
    await getStorage().putBytes(casKey(SHA, "video/mp4"), mp4, "video/mp4", { sha256: SHA });
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post({ url: "https://example.com/ignored.mp4", sha256: SHA, mime: "video/mp4", kind: "video", durationSec: 5 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.checksum).toBe(SHA);
    expect(body.data.storageKey).toBe(casKey(SHA, "video/mp4"));
    expect(fetchSpy).not.toHaveBeenCalled(); // proof of the no-fetch fast-path
  });

  it("falls back to fetch+store when the referenced object is NOT in the bucket", async () => {
    if (!TEST_DB) return;
    getStorage(); // empty bucket — HEAD will miss
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post({ url: "https://example.com/real.mp4", sha256: "d".repeat(64), mime: "video/mp4", kind: "video" });
    expect(res.status).toBe(202);
    await drain();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("rejects sha256 without kind+mime (422) and attempts no fetch", async () => {
    if (!TEST_DB) return;
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ url: "https://example.com/x.mp4", sha256: SHA }); // no kind/mime
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("url-only request returns a polling handle", async () => {
    if (!TEST_DB) return;
    getStorage();
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ url: "https://example.com/plain.mp4" });
    expect(res.status).toBe(202);
    await drain();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

async function drain() {
  const { createTaskList } = await import("@/lib/queue/tasks");
  await runOnce({ connectionString: TEST_DB!, taskList: { "media-ingest": createTaskList()["media-ingest"] } });
}
const get = (id: string, key = WRITE_KEY) => app.request(`/api/v1/media/${id}`, { headers: { authorization: `Bearer ${key}` } });

describe("remote media polling contract", () => {
  it("accepts a slow HTTP source immediately, shares the in-flight handle, and exposes playable metadata", async () => {
    const bytes = readFileSync("e2e/fixtures/tiktok-preview.mp4");
    let downloads = 0;
    const source = createServer((_req, res) => {
      downloads++;
      setTimeout(() => { res.writeHead(200, { "content-type": "video/mp4" }); res.end(bytes); }, 20_000);
    });
    await new Promise<void>(resolve => source.listen(0, "127.0.0.1", resolve));
    const port = (source.address() as { port: number }).port;
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => nativeFetch(`http://127.0.0.1:${port}/video`, init));
    try {
      const start = Date.now();
      const responses = await Promise.all([post({ url: "https://example.com/slow.mp4" }), post({ url: "https://example.com/slow.mp4" })]);
      expect(responses.map(r => r.status)).toEqual([202, 202]);
      expect(Date.now() - start).toBeLessThan(2000);
      const [first, second] = await Promise.all(responses.map(r => r.json()));
      expect(first.data.status).toBe("ingesting");
      expect(second.data.id).toBe(first.data.id);
      expect(downloads).toBe(0);
      expect((await (await get(first.data.id)).json()).data.status).toBe("ingesting");
      expect((await get(first.data.id, UNRELATED_KEY)).status).toBe(403);
      await drain();
      const ready = await (await get(first.data.id)).json();
      expect(ready.data).toMatchObject({ id: first.data.id, status: "ready", size: bytes.length, durationSec: 1, kind: "video", mime: "video/mp4", error: null });
      expect(ready.data.url).toMatch(/^https?:/);
      expect(ready.data.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(downloads).toBe(1);
    } finally { await new Promise<void>(resolve => source.close(() => resolve())); }
  });

  it("keeps an accepted job after the requester disconnects and supports bounded wait", async () => {
    vi.stubGlobal("fetch", async () => new Response(mp4, { headers: { "content-type": "video/mp4" } }));
    const controller = new AbortController();
    const response = await app.request("/api/v1/media", { method: "POST", headers: auth, body: JSON.stringify({ url: "https://example.com/detached.mp4" }), signal: controller.signal });
    expect(response.status).toBe(202);
    const { data } = await response.json();
    controller.abort();
    await drain();
    expect((await (await get(data.id)).json()).data.status).toBe("ready");
    const waiting = app.request("/api/v1/media?wait=true", { method: "POST", headers: auth, body: JSON.stringify({ url: "https://example.com/wait.mp4" }) });
    await expect.poll(async () => (await db.query.media.findMany()).some(m => m.source_url === "https://example.com/wait.mp4")).toBe(true);
    await drain();
    const ready = await waiting;
    expect(ready.status).toBe(201);
    expect((await ready.json()).data.status).toBe("ready");
  });

  it("does not return or deduplicate another workspace's handle", async () => {
    const { seedWorkspace } = await import("../../../../../tests/helpers/workspace");
    const other = await seedWorkspace(db, schema, { slug: `media-other-${Date.now()}` });
    const { enqueueIngest } = await import("@/lib/media/async-ingest");
    try {
      const outside = await enqueueIngest("https://example.com/same.mp4", other);
      expect((await get(outside.id)).status).toBe(404);
      const inside = await (await post({ url: "https://example.com/same.mp4" })).json();
      expect(inside.data.id).not.toBe(outside.id);
    } finally {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, other));
    }
  });

  it("persists a source failure and rejects unknown handles", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
    const response = await post({ url: "https://example.com/unavailable.mp4" });
    expect(response.status).toBe(202);
    const { data } = await response.json();
    await drain();
    const failed = await (await get(data.id)).json();
    expect(failed.data.status).toBe("failed");
    expect(failed.data.error).toContain("503");
    expect((await get("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await get("bad-id")).status).toBe(422);
  });
});
