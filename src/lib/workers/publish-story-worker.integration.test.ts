import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { JobHelpers } from "graphile-worker";
import type { StoryCard } from "@/lib/stories";
import { eq, sql } from "drizzle-orm";
import documented from "../../../tests/fixtures/provider-docs/article-story.json";

const { prepareStoryMedia } = vi.hoisted(() => ({ prepareStoryMedia: vi.fn() }));
vi.mock("@/lib/stories/media", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/stories/media")>(), prepareStoryMedia,
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let processPublishStory: typeof import("./publish-story-worker").processPublishStory;
let __setStoryRenderer: typeof import("@/lib/stories").__setStoryRenderer;
let getStorage: typeof import("@/lib/storage").getStorage;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ processPublishStory } = await import("./publish-story-worker"));
  ({ __setStoryRenderer } = await import("@/lib/stories"));
  ({ getStorage } = await import("@/lib/storage"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `story-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  prepareStoryMedia.mockReset().mockResolvedValue({});
  await db.delete(schema.outboundDeliveries).where(eq(schema.outboundDeliveries.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
});
afterEach(() => {
  __setStoryRenderer(null);
  vi.restoreAllMocks();
});

const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

async function seed() {
  const [c] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: "IG_ACCT_1",
      display_name: "Test IG",
      connection_mode: "derived",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
    })
    .returning();
  const [m] = await db
    .insert(schema.media)
    .values({ workspace_id: WS, checksum: `c${Math.random()}`, storage_key: "k", url: "https://cdn/x.mp4", kind: "video" })
    .returning();
  const [d] = await db
    .insert(schema.deliveries)
    .values({
      workspace_id: WS,
      channel_id: c!.id,
      format: "video",
      status: "sent",
      payload: { format: "video", media: [{ mediaId: m!.id }], caption: "Nowy post!" },
      scheduled_at: new Date(),
      run_at: new Date(),
    })
    .returning();
  return { channelId: c!.id, deliveryId: d!.id };
}

function fakeRenderer() {
  const render = vi.fn(async (_card: StoryCard) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  __setStoryRenderer({ render });
  return render;
}

describe("publish-story worker (STORY1)", () => {
  it("renders the card, uploads it, publishes the Story, and records the ledger as sent", async () => {
    if (!TEST_DB) return;
    const { channelId, deliveryId } = await seed();
    const render = fakeRenderer();
    const pub = vi
      .spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValue({ providerHandle: "STORY_PMID" });

    await processPublishStory({ channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` }, helpers);

    // Ledger: sent + platform id.
    const row = await db.query.outboundDeliveries.findFirst({
      where: eq(schema.outboundDeliveries.delivery_key, `auto-story:${deliveryId}`),
    });
    expect(row?.status).toBe("sent");
    expect(row?.platform_message_id).toBe("STORY_PMID");
    expect(row?.task_name).toBe("publish-story");

    // Renderer got the post's caption + the channel name.
    expect(render).toHaveBeenCalledTimes(1);
    expect(render.mock.calls[0]![0]).toMatchObject({ caption: "Nowy post!", accountName: "Test IG" });

    // The fresh card was uploaded to public storage at the deterministic key, and publishStory was
    // handed its public URL + the channel's account id.
    const key = `stories/${deliveryId}.jpg`;
    expect((await getStorage().head(key)).exists).toBe(true);
    expect(pub).toHaveBeenCalledTimes(1);
    expect(pub.mock.calls[0]![0]).toMatchObject({ accountId: "IG_ACCT_1", mediaUrl: getStorage().publicUrl(key) });
  });

  it("is idempotent: a second run skips the duplicate and publishes only once", async () => {
    if (!TEST_DB) return;
    const { channelId, deliveryId } = await seed();
    fakeRenderer();
    const pub = vi
      .spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValue({ providerHandle: "STORY_DUP" });

    const args = { channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` };
    await processPublishStory(args, helpers);
    await processPublishStory(args, helpers);

    expect(pub).toHaveBeenCalledTimes(1);
  });

  it.each(["image", "video"] as const)("publishes the selected %s once without rendering a card", async kind => {
    const { channelId, deliveryId } = await seed();
    await db.update(schema.channels).set({ default_auto_story_mode: "media" }).where(eq(schema.channels.id, channelId));
    prepareStoryMedia.mockResolvedValue({ mediaUrls: ["https://cdn.example/story"], mediaKind: kind });
    const render = fakeRenderer();
    const pub = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValue({ providerHandle: documented.published.id });
    const args = { channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` };
    await processPublishStory(args, helpers);
    await processPublishStory(args, helpers);
    expect(prepareStoryMedia).toHaveBeenCalledWith(expect.anything(), WS, "instagram", "media", `stories/${deliveryId}`);
    expect(render).not.toHaveBeenCalled();
    expect(pub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mediaUrl: "https://cdn.example/story", mediaKind: kind }));
  });

  it("publishes split clips in order and a retry continues after the last published clip", async () => {
    const { channelId, deliveryId } = await seed();
    await db.update(schema.channels).set({ default_auto_story_mode: "media" }).where(eq(schema.channels.id, channelId));
    const clips = [1, 2, 3].map(i => `https://bucket.example/stories/${deliveryId}/clip-${i}.mp4`);
    prepareStoryMedia.mockResolvedValue({ mediaUrls: clips, mediaKind: "video" });
    const pub = vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValueOnce({ providerHandle: "S1" })
      .mockRejectedValueOnce(new Error("Story unavailable"))
      .mockResolvedValueOnce({ providerHandle: "S2" })
      .mockResolvedValueOnce({ providerHandle: "S3" });
    const args = { channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` };
    await expect(processPublishStory(args, helpers)).rejects.toThrow("Story unavailable");
    const failed = await db.query.outboundDeliveries.findFirst({ where: eq(schema.outboundDeliveries.delivery_key, args.idempotencyKey) });
    expect(failed).toMatchObject({ status: "failed", payload: { storyClipHandles: ["S1"] } });
    await processPublishStory(args, helpers);
    await processPublishStory(args, helpers);
    expect(pub.mock.calls.map(call => call[0].mediaUrl)).toEqual([clips[0], clips[1], clips[1], clips[2]]);
    const sent = await db.query.outboundDeliveries.findFirst({ where: eq(schema.outboundDeliveries.delivery_key, args.idempotencyKey) });
    expect(sent).toMatchObject({ status: "sent", platform_message_id: "S1", payload: { storyClipHandles: ["S1", "S2", "S3"] } });
  });

  it("records the card fallback reason and respects the post mode", async () => {
    const { channelId, deliveryId } = await seed();
    await db.update(schema.deliveries).set({ payload: { format: "video", media: [], autoStoryMode: "media" } }).where(eq(schema.deliveries.id, deliveryId));
    prepareStoryMedia.mockResolvedValue({ fallbackReason: "video_duration", thumbnail: new Uint8Array([1]) });
    const render = fakeRenderer();
    vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValue({ providerHandle: documented.published.id });
    await processPublishStory({ channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` }, helpers);
    expect(prepareStoryMedia).toHaveBeenCalledWith(expect.anything(), WS, "instagram", "media", `stories/${deliveryId}`);
    expect(render.mock.calls[0]?.[0].thumbnail).toEqual(new Uint8Array([1]));
    const row = await db.query.outboundDeliveries.findFirst({ where: eq(schema.outboundDeliveries.delivery_key, `auto-story:${deliveryId}`) });
    expect(row?.payload).toMatchObject({ storyFallbackReason: "video_duration" });
    expect((await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, deliveryId) }))?.status).toBe("sent");
  });

  it("keeps the published post sent when its Story fails", async () => {
    const { channelId, deliveryId } = await seed();
    fakeRenderer();
    vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockRejectedValue(new Error("Story unavailable"));
    await expect(processPublishStory({ channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` }, helpers)).rejects.toThrow("Story unavailable");
    expect((await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, deliveryId) }))?.status).toBe("sent");
    expect((await db.query.outboundDeliveries.findFirst({ where: eq(schema.outboundDeliveries.delivery_key, `auto-story:${deliveryId}`) }))?.status).toBe("failed");
  });

  it("no-ops when the source delivery is gone", async () => {
    if (!TEST_DB) return;
    const render = fakeRenderer();
    await processPublishStory(
      { channelId: "00000000-0000-0000-0000-000000000000", deliveryId: "00000000-0000-0000-0000-000000000001", idempotencyKey: "auto-story:none" },
      helpers,
    );
    expect(render).not.toHaveBeenCalled();
  });
});

describe("Story card language selection", () => {
  it.each([
    ["pl", "en", "pl"], ["pl-PL", null, "pl-PL"], ["en", "pl", "en"],
    [null, null, "en"], [null, "pl-PL", "pl-PL"], ["de", "pl", "de"],
  ])("uses post %s before content %s", async (postLanguage, contentLanguage, expected) => {
    const { channelId, deliveryId } = await seed();
    const [content] = await db.insert(schema.content).values({ workspace_id: WS, title: "Language", language: contentLanguage }).returning();
    await db.insert(schema.posts).values({ workspace_id: WS, content_id: content!.id, delivery_id: deliveryId, platform: "instagram", language: postLanguage });
    const render = fakeRenderer();
    vi.spyOn((await import("@/lib/providers/meta")).metaProvider, "publishStory")
      .mockResolvedValue({ providerHandle: documented.published.id });
    await processPublishStory({ channelId, deliveryId, idempotencyKey: `auto-story:${deliveryId}` }, helpers);
    expect(render.mock.calls[0]?.[0]).toMatchObject({ language: expected, format: "video" });
  });
});
