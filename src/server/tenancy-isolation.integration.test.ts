import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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

// The "safe multi-tenant" proof (UNIFY1 decision #4): a request resolved to workspace A must NEVER
// read or mutate workspace B's rows. Two seeded workspaces; every ported publishing resource is
// checked for cross-workspace access — it must resolve to empty/not-found, never B's data. These
// invariants stay green forever so multi-tenant can activate later with zero isolation debt.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let content: typeof import("@/lib/content/service");
let deliveriesSvc: typeof import("@/lib/deliveries/service");
let media: typeof import("@/lib/media/service");
let brands: typeof import("@/lib/brands/service");
let InMemoryStorage: typeof import("@/lib/storage/memory").InMemoryStorage;
let seedWorkspace: typeof import("../../tests/helpers/workspace").seedWorkspace;
let A = "";
let B = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  content = await import("@/lib/content/service");
  deliveriesSvc = await import("@/lib/deliveries/service");
  media = await import("@/lib/media/service");
  brands = await import("@/lib/brands/service");
  ({ InMemoryStorage } = await import("@/lib/storage/memory"));
  ({ seedWorkspace } = await import("../../tests/helpers/workspace"));
  A = await seedWorkspace(db, schema, { slug: `tenA-${Date.now()}` });
  B = await seedWorkspace(db, schema, { slug: `tenB-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [A, B]) await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws));
  await db.$client.end();
});

describe("tenancy isolation — A never reads/mutates B", () => {
  it("content: B's row is invisible to A (get/patch/delete)", async () => {
    if (!TEST_DB) return;
    const c = await content.createContent({ title: "B secret" }, B);
    expect(await content.getContent(c.id, A)).toBeUndefined();
    expect(await content.patchContent(c.id, A, { status: "hacked" })).toBeUndefined();
    expect(await content.deleteContent(c.id, A)).toBe(false);
    // still there for B, unchanged
    expect((await content.getContent(c.id, B))!.status).toBe("draft");
  });

  it("posts: B's row is invisible to A", async () => {
    if (!TEST_DB) return;
    const p = await content.createPost({ platform: "tiktok", description: "B" }, B);
    expect(await content.getPost(p.id, A)).toBeUndefined();
    expect(await content.deletePost(p.id, A)).toBe(false);
    expect(await content.getPost(p.id, B)).toBeDefined();
  });

  it("content/posts lists never surface the other workspace's rows", async () => {
    if (!TEST_DB) return;
    const aList = await content.listContent({ workspaceId: A, limit: 100 });
    expect(aList.items.every((r) => r.workspace_id === A)).toBe(true);
    const aPosts = await content.listPosts({ workspaceId: A, limit: 100 });
    expect(aPosts.items.every((r) => r.workspace_id === A)).toBe(true);
  });

  it("media: B's row is invisible to A (getMedia)", async () => {
    if (!TEST_DB) return;
    const storage = new InMemoryStorage("https://cdn.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } })));
    const m = await media.registerByUrl("https://example.com/x.jpg", { storage, probe: async () => ({ kind: "image", mime: "image/jpeg" }), resolve: async () => ["93.184.216.34"] }, B);
    expect(await media.getMedia(m.id, A)).toBeUndefined();
    expect(await media.getMedia(m.id, B)).toBeDefined();
    vi.unstubAllGlobals();
  });

  it("brands: B's brand is invisible to A; same key allowed per workspace", async () => {
    if (!TEST_DB) return;
    await brands.createBrand({ key: "shared", name: "B brand" }, B);
    expect(await brands.getBrand(A, "shared")).toBeUndefined(); // A doesn't see it
    // A can use the SAME key independently
    await expect(brands.createBrand({ key: "shared", name: "A brand" }, A)).resolves.toMatchObject({ key: "shared" });
    await expect(brands.updateBrand(A, "shared", { name: "A renamed" })).resolves.toMatchObject({ name: "A renamed" });
    // B's brand is untouched
    expect((await brands.getBrand(B, "shared"))!.name).toBe("B brand");
  });

  it("deliveries: B's delivery is invisible to A (get/cancel)", async () => {
    if (!TEST_DB) return;
    const { encryptTokens } = await import("@/lib/crypto");
    const [ch] = await db.insert(schema.channels).values({
      workspace_id: B, platform: "tiktok", platform_id: `tenB-${Math.random()}`, connection_mode: "manual_token",
      status: "active", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });
    const [d] = await db.insert(schema.deliveries).values({
      workspace_id: B, channel_id: ch!.id, format: "video", status: "scheduled",
      payload: { format: "video", media: [] }, scheduled_at: new Date(), run_at: new Date(),
    }).returning({ id: schema.deliveries.id });
    expect(await deliveriesSvc.getDelivery(d!.id, A)).toBeUndefined();
    await expect(deliveriesSvc.cancelDelivery(d!.id, A)).rejects.toMatchObject({ status: 409 });
    expect(await deliveriesSvc.getDelivery(d!.id, B)).toBeDefined();
  });

  it("deliveries: a held post is cancelable (held -> canceled); a sent post is not (409)", async () => {
    if (!TEST_DB) return;
    const { encryptTokens } = await import("@/lib/crypto");
    const [ch] = await db.insert(schema.channels).values({
      workspace_id: A, platform: "tiktok", platform_id: `tenA-${Math.random()}`, connection_mode: "manual_token",
      status: "active", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });
    const mk = async (status: "held" | "scheduled" | "sent") => {
      const [d] = await db.insert(schema.deliveries).values({
        workspace_id: A, channel_id: ch!.id, format: "video", status,
        payload: { format: "video", media: [] }, scheduled_at: new Date(), run_at: new Date(),
      }).returning({ id: schema.deliveries.id });
      return d!.id;
    };
    // The bug: cancelDelivery only matched status='scheduled', but the queue UI offers Cancel for
    // 'held' too — so cancelling a held (e.g. token-invalid) post 409'd. A held post must be cancelable.
    const heldId = await mk("held");
    await deliveriesSvc.cancelDelivery(heldId, A);
    expect((await deliveriesSvc.getDelivery(heldId, A))!.status).toBe("canceled");
    // scheduled stays cancelable
    const schedId = await mk("scheduled");
    await deliveriesSvc.cancelDelivery(schedId, A);
    expect((await deliveriesSvc.getDelivery(schedId, A))!.status).toBe("canceled");
    // a sent post is terminal — not cancelable
    const sentId = await mk("sent");
    await expect(deliveriesSvc.cancelDelivery(sentId, A)).rejects.toMatchObject({ status: 409 });
  });
});
