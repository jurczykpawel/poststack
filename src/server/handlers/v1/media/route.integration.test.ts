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
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

// POST /api/v1/media reference fast-path: when sha256+mime+kind are supplied, an object already in the
// shared CAS bucket is LINKED with no outbound fetch (registerKnownMedia); on not_present it falls back
// to fetch+store (registerByUrl). The route's getStorage() returns the process-global InMemoryStorage
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
  await db.insert(schema.apiKeys).values({
    workspace_id: WS,
    name: "media",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: RAW_KEY.slice(0, 16),
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
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
const post = (body: unknown) =>
  app.request("/api/v1/media", { method: "POST", headers: auth, body: JSON.stringify(body) });

describe("POST /api/v1/media — sha256 reference fast-path", () => {
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
    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalled(); // not_present → fell through to registerByUrl
  });

  it("rejects sha256 without kind+mime (422) and attempts no fetch", async () => {
    if (!TEST_DB) return;
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ url: "https://example.com/x.mp4", sha256: SHA }); // no kind/mime
    expect(res.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("url-only request is unchanged (fetch+store path)", async () => {
    if (!TEST_DB) return;
    getStorage();
    const fetchSpy = vi.fn(async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post({ url: "https://example.com/plain.mp4" });
    expect(res.status).toBe(201);
    expect(fetchSpy).toHaveBeenCalled();
  });
});
