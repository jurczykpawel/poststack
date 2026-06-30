import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

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

import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let registerByUrl: typeof import("./service").registerByUrl;
let registerKnownMedia: typeof import("./service").registerKnownMedia;
let casKey: typeof import("@/lib/media/cas").casKey;
let InMemoryStorage: typeof import("@/lib/storage/memory").InMemoryStorage;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ registerByUrl, registerKnownMedia } = await import("./service"));
  ({ casKey } = await import("@/lib/media/cas"));
  ({ InMemoryStorage } = await import("@/lib/storage/memory"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `media-${Date.now()}` });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.media);
});

afterAll(async () => {
  if (!TEST_DB) return;
  // Clean up everything this suite created so it never pollutes serially-following files.
  await db.delete(schema.media);
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

const fakeProbe = async () => ({
  kind: "video" as const,
  mime: "video/mp4",
  width: 1080,
  height: 1920,
  durationSec: 12,
});
const bytes = new Uint8Array([1, 2, 3, 4]);

function stubFetch() {
  const storage = new InMemoryStorage("https://cdn.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } })),
  );
  return storage;
}

describe("media registerByUrl (real Postgres, workspace-scoped)", () => {
  it("ingests a public URL, stores content-addressed, and probes metadata", async () => {
    if (!TEST_DB) return;
    const storage = stubFetch();
    const m = await registerByUrl("https://cdn.test/source.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS);
    expect(m.workspace_id).toBe(WS);
    expect(m.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(m.storage_key).toContain("media/sha256/");
    expect(m.duration_sec).toBe(12);
    expect((await storage.head(m.storage_key)).exists).toBe(true);
    vi.unstubAllGlobals();
  });

  it("deduplicates identical content within a workspace (same checksum -> same row)", async () => {
    if (!TEST_DB) return;
    const storage = stubFetch();
    const a = await registerByUrl("https://cdn.test/a.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS);
    const b = await registerByUrl("https://cdn.test/b.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS);
    expect(b.id).toBe(a.id);
    vi.unstubAllGlobals();
  });

  it("the SAME content in a DIFFERENT workspace gets its own row (no cross-tenant share)", async () => {
    if (!TEST_DB) return;
    const storage = stubFetch();
    const WS2 = await seedWorkspace(db, schema, { slug: `media2-${Date.now()}` });
    const a = await registerByUrl("https://cdn.test/a.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS);
    const b = await registerByUrl("https://cdn.test/a.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS2);
    expect(b.id).not.toBe(a.id);
    expect(b.workspace_id).toBe(WS2);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
    vi.unstubAllGlobals();
  });

  it("refuses a private/internal URL (SSRF)", async () => {
    if (!TEST_DB) return;
    const storage = stubFetch();
    await expect(
      registerByUrl("http://169.254.169.254/latest/meta-data", { storage, probe: fakeProbe, resolve: async () => ["169.254.169.254"] }, WS),
    ).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it("two concurrent identical ingests resolve to one row without a unique-violation 500 [PSA34]", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "video/mp4" } })));
    const slowProbe = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return fakeProbe();
    };
    try {
      const [a, b] = await Promise.all([
        registerByUrl("https://cdn.test/a.mp4", { storage, probe: slowProbe, resolve: async () => ["8.8.8.8"] }, WS),
        registerByUrl("https://cdn.test/b.mp4", { storage, probe: slowProbe, resolve: async () => ["8.8.8.8"] }, WS),
      ]);
      expect(a.id).toBe(b.id);
      const rows = await db.select().from(schema.media).where(eq(schema.media.workspace_id, WS));
      expect(rows.length).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("aborts a hung source after MEDIA_FETCH_TIMEOUT_MS instead of pinning a slot forever [PSA32]", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    process.env.MEDIA_FETCH_TIMEOUT_MS = "50";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    try {
      await expect(
        registerByUrl("https://cdn.test/hung.mp4", { storage, probe: fakeProbe, resolve: async () => ["8.8.8.8"] }, WS),
      ).rejects.toThrow();
    } finally {
      delete process.env.MEDIA_FETCH_TIMEOUT_MS;
      vi.unstubAllGlobals();
    }
  });
});

describe("media registerKnownMedia (link by reference, no re-upload, workspace-scoped)", () => {
  const CHK = "a".repeat(64);

  it("links an object already in the bucket without fetching — row points at the CAS key", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    const key = casKey(CHK, "video/mp4");
    await storage.putBytes(key, bytes, "video/mp4", { sha256: CHK });
    const m = await registerKnownMedia({ checksum: CHK, mime: "video/mp4", kind: "video", durationSec: 9 }, { storage }, WS);
    expect(m.workspace_id).toBe(WS);
    expect(m.checksum).toBe(CHK);
    expect(m.storage_key).toBe(key);
    expect(m.duration_sec).toBe(9);
    expect(m.url).toBe(storage.publicUrl(key));
  });

  it("throws not_present (422) when the object is absent, so the caller can fall back to registerByUrl", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    await expect(
      registerKnownMedia({ checksum: "b".repeat(64), mime: "video/mp4", kind: "video" }, { storage }, WS),
    ).rejects.toMatchObject({ code: "not_present", status: 422 });
  });

  it("is idempotent within a workspace: a second call returns the same row (CAS dedup)", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    const key = casKey(CHK, "video/mp4");
    await storage.putBytes(key, bytes, "video/mp4", { sha256: CHK });
    const a = await registerKnownMedia({ checksum: CHK, mime: "video/mp4", kind: "video" }, { storage }, WS);
    const b = await registerKnownMedia({ checksum: CHK, mime: "video/mp4", kind: "video" }, { storage }, WS);
    expect(b.id).toBe(a.id);
  });

  it("mime omitted → key uses .bin and the row's mime is null", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    const key = casKey(CHK, undefined);
    await storage.putBytes(key, bytes, "application/octet-stream");
    const m = await registerKnownMedia({ checksum: CHK, kind: "video" }, { storage }, WS);
    expect(m.storage_key).toBe(key);
    expect(m.mime).toBeNull();
  });

  it("the SAME known object in a DIFFERENT workspace gets its own row (no cross-tenant share)", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    const key = casKey(CHK, "video/mp4");
    await storage.putBytes(key, bytes, "video/mp4", { sha256: CHK });
    const WS2 = await seedWorkspace(db, schema, { slug: `mediak2-${Date.now()}` });
    const a = await registerKnownMedia({ checksum: CHK, mime: "video/mp4", kind: "video" }, { storage }, WS);
    const b = await registerKnownMedia({ checksum: CHK, mime: "video/mp4", kind: "video" }, { storage }, WS2);
    expect(b.id).not.toBe(a.id);
    expect(b.workspace_id).toBe(WS2);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });
});
