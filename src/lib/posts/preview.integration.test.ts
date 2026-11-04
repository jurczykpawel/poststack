import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let preview: typeof import("./preview");
let storage: import("@/lib/storage/memory").InMemoryStorage;

const WS = "e7e7e7e7-0000-4000-8000-0000000000a1";
const OTHER_WS = "e7e7e7e7-0000-4000-8000-0000000000b1";
const CH = "e7e7e7e7-0000-4000-8000-0000000000c1";
const IG = "e7e7e7e7-0000-4000-8000-0000000000c2";
const OTHER_CH = "e7e7e7e7-0000-4000-8000-0000000000c3";
const DELIVERY = "e7e7e7e7-0000-4000-8000-0000000000d1";
const MEDIA = "e7e7e7e7-0000-4000-8000-0000000000e1";

// Recorded Graph shapes (GET /{id}?fields=…), see facebook.test.ts / instagram.test.ts.
const FB_POST = {
  message: "Nowy odcinek już jest 🎬",
  full_picture: "https://scontent-waw2-1.xx.fbcdn.net/v/t39.30808-6/465_n.jpg?stp=dst-jpg_s720x720&oe=6730A1B2",
  permalink_url: "https://www.facebook.com/122100000000000001/posts/pfbid02abc",
  created_time: "2026-10-30T08:15:00+0000",
  id: "PG1_122111111111111111",
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const realFetch = globalThis.fetch;
let graphCalls = 0;

function graph(status: number, body: unknown) {
  graphCalls = 0;
  globalThis.fetch = vi.fn(async () => {
    graphCalls++;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const fetchImage = vi.fn(async () => new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } }));

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  preview = await import("./preview");
  const { InMemoryStorage } = await import("@/lib/storage/memory");
  storage = new InMemoryStorage("https://cdn.poststack.test");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  fetchImage.mockClear();
  const { encryptTokens } = await import("@/lib/crypto");
  const token = encryptTokens({ access_token: "pagetok" });
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
  await db.insert(s.workspaces).values([{ id: WS, name: "P", slug: `p-${WS}` }, { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` }]);
  await db.insert(s.channels).values([
    { id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG1", display_name: "Acme Page", token_encrypted: token, webhook_secret: "a", status: "active" },
    { id: IG, workspace_id: WS, platform: "instagram", platform_id: "IG1", display_name: "Studio IG", token_encrypted: "not-decryptable", webhook_secret: "b", status: "active" },
    { id: OTHER_CH, workspace_id: OTHER_WS, platform: "facebook", platform_id: "PG9", display_name: "Foreign", token_encrypted: token, webhook_secret: "c", status: "active" },
  ]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const id of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, id));
});

describe("externalPostCard (a post made outside PostStack)", () => {
  it("fetches once, copies the picture into our storage and serves later views from the database", async () => {
    if (!TEST_DB) return;
    graph(200, FB_POST);
    const card = await preview.externalPostCard(WS, CH, FB_POST.id, { storage, fetchImage });
    expect(card).toMatchObject({ platform: "facebook", channelName: "Acme Page", text: FB_POST.message, url: FB_POST.permalink_url, at: new Date("2026-10-30T08:15:00Z") });
    expect(card!.imageUrl).toMatch(/^https:\/\/cdn\.poststack\.test\/.+\.jpg$/);
    expect(fetchImage).toHaveBeenCalledWith(FB_POST.full_picture);
    expect(graphCalls).toBe(1);

    const again = await preview.externalPostCard(WS, CH, FB_POST.id, { storage, fetchImage });
    expect(again).toEqual(card);
    expect(graphCalls).toBe(1);
  });

  it("keeps the text when the picture cannot be copied", async () => {
    if (!TEST_DB) return;
    graph(200, FB_POST);
    const card = await preview.externalPostCard(WS, CH, FB_POST.id, { storage, fetchImage: async () => new Response("<html>", { status: 403 }) });
    expect(card).toMatchObject({ text: FB_POST.message, imageUrl: null });
  });

  it("a Graph error or an undecryptable token gives a card without content, remembered, never a throw", async () => {
    if (!TEST_DB) return;
    graph(400, { error: { message: "Unsupported get request", code: 100 } });
    expect(await preview.externalPostCard(WS, CH, "PG1_gone", { storage, fetchImage })).toMatchObject({ channelName: "Acme Page", text: null, imageUrl: null, url: null });
    expect(await preview.externalPostCard(WS, IG, "1811", { storage, fetchImage })).toMatchObject({ platform: "instagram", text: null });
    const rows = await db.select().from(s.postPreviews).where(eq(s.postPreviews.workspace_id, WS));
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "failed"]);
    await preview.externalPostCard(WS, CH, "PG1_gone", { storage, fetchImage });
    expect(graphCalls).toBe(1);
  });

  it("does not open another workspace's channel", async () => {
    if (!TEST_DB) return;
    graph(200, FB_POST);
    expect(await preview.externalPostCard(WS, OTHER_CH, FB_POST.id, { storage, fetchImage })).toBeUndefined();
    expect(graphCalls).toBe(0);
  });
});

describe("deliveryPostCard (a post PostStack published)", () => {
  beforeEach(async () => {
    if (!TEST_DB) return;
    await db.insert(s.media).values({ id: MEDIA, workspace_id: WS, checksum: "c1", storage_key: "k", url: "https://cdn.poststack.test/media/a.jpg", kind: "image" });
    await db.insert(s.deliveries).values({
      id: DELIVERY, workspace_id: WS, channel_id: CH, format: "post", status: "sent", scheduled_at: new Date("2026-10-29T10:00:00Z"),
      payload: { format: "post", media: [{ mediaId: MEDIA }], caption: "payload caption" }, provider_handle: "PG1_1",
    });
    await db.insert(s.posts).values({
      workspace_id: WS, delivery_id: DELIVERY, platform: "facebook", description: "Our caption", status: "published",
      published_url: "https://www.facebook.com/PG1/posts/1", published_at: new Date("2026-10-29T10:01:00Z"), platform_post_id: "PG1_1",
    });
  });

  it("builds the card from our own rows without calling the platform", async () => {
    if (!TEST_DB) return;
    graph(500, {});
    expect(await preview.deliveryPostCard(WS, DELIVERY)).toEqual({
      platform: "facebook", channelName: "Acme Page", text: "Our caption", imageUrl: "https://cdn.poststack.test/media/a.jpg", video: false,
      url: "https://www.facebook.com/PG1/posts/1", at: new Date("2026-10-29T10:01:00Z"),
    });
    expect(graphCalls).toBe(0);
    expect(await preview.deliveryPostCard(OTHER_WS, DELIVERY)).toBeUndefined();
  });

  // PROVFIX1 (recorded 2026-11-04, __fixtures__/recorded/prod-stored-handles.json): a reel stored before FBREEL1 kept
  // a bare post id; watch/?v=<it> opens Facebook's generic Watch page, /<page>/posts/<it> opens the reel.
  it("links a legacy bare-id Facebook reel through its Page, not the Watch page", async () => {
    if (!TEST_DB) return;
    await db.delete(s.posts).where(eq(s.posts.delivery_id, DELIVERY));
    await db.update(s.deliveries).set({ format: "reel", provider_handle: "9352453763801277" }).where(eq(s.deliveries.id, DELIVERY));
    expect((await preview.deliveryPostCard(WS, DELIVERY))?.url).toBe("https://www.facebook.com/PG1/posts/9352453763801277");
  });

  it("gives an unpublished (published=false) post no link — it has no public page", async () => {
    if (!TEST_DB) return;
    await db.delete(s.posts).where(eq(s.posts.delivery_id, DELIVERY));
    await db.update(s.deliveries).set({
      provider_handle: "554158337282822679",
      payload: { format: "post", media: [{ mediaId: MEDIA }], caption: "draft", options: { mediaKind: "image", published: false } },
    }).where(eq(s.deliveries.id, DELIVERY));
    expect((await preview.deliveryPostCard(WS, DELIVERY))?.url).toBeNull();
  });

  it("without a posts row the time is when it was published (sent_at), not the last row update", async () => {
    if (!TEST_DB) return;
    await db.delete(s.posts).where(eq(s.posts.delivery_id, DELIVERY));
    await db.update(s.deliveries).set({ sent_at: new Date("2026-10-29T10:01:00Z"), updated_at: new Date("2026-10-29T10:11:00Z") }).where(eq(s.deliveries.id, DELIVERY));
    expect((await preview.deliveryPostCard(WS, DELIVERY))?.at).toEqual(new Date("2026-10-29T10:01:00Z"));
  });
});
