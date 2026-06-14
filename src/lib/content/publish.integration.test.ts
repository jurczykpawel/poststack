import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let publishPost: typeof import("./publish").publishPost;
type PublishPostDeps = import("./publish").PublishPostDeps;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let WS = "";
let fakeRegister: PublishPostDeps;

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
  ({ publishPost } = await import("./publish"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `publish-${Date.now()}` });

  // Fake media registration — inserts a media row (workspace-scoped), returns its id (no network/storage).
  fakeRegister = {
    registerMedia: async (url, workspaceId) => {
      const [m] = await db
        .insert(schema.media)
        .values({ workspace_id: workspaceId, checksum: `c${Math.random()}`, storage_key: "k", url, kind: "video" })
        .returning();
      return { id: m!.id };
    },
  };
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
});

// Seed an instagram channel + an instagram editorial post. The trunk stores instagram as a distinct
// platform (no meta+subKind), so a matching publish target is an `instagram` channel.
async function fixtures(overrides: Partial<typeof schema.posts.$inferInsert> = {}) {
  const [ch] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: `acct-${Math.random()}`,
      connection_mode: "manual_token",
      token_encrypted: encryptTokens({ access_token: "t" }),
      webhook_secret: "wh",
    })
    .returning();
  const [c] = await db
    .insert(schema.content)
    .values({ workspace_id: WS, title: "Reel", content_type: "reel" })
    .returning();
  const [p] = await db
    .insert(schema.posts)
    .values({
      workspace_id: WS,
      content_id: c!.id,
      platform: "instagram",
      description: "caption here",
      hashtags: "#a #b",
      video_url: "https://cdn/x.mp4",
      cover_url: "https://cdn/cover.png",
      status: "planned",
      ...overrides,
    })
    .returning();
  return { channelId: ch!.id, postId: p!.id };
}

describe("publishPost", () => {
  it("when=now creates a scheduled delivery, links it, flips status", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await fixtures();
    const { delivery, post } = await publishPost({ postId, channelId, when: "now" }, WS, fakeRegister);
    expect(delivery.status).toBe("scheduled");
    expect(delivery.format).toBe("reel"); // instagram + video → reel
    expect(delivery.channel_id).toBe(channelId);
    expect((delivery.payload as { caption?: string }).caption).toBe("caption here\n\n#a #b");
    expect((delivery.payload as { options?: { coverUrl?: string } }).options?.coverUrl).toBe("https://cdn/cover.png");
    expect(post.delivery_id).toBe(delivery.id);
    expect(post.status).toBe("scheduled");
    // scheduled ~ now
    expect(Math.abs(delivery.scheduled_at.getTime() - Date.now())).toBeLessThan(10_000);
  });

  it("when=<future ISO> schedules the delivery at that time", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await fixtures();
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const { delivery } = await publishPost({ postId, channelId, when }, WS, fakeRegister);
    expect(delivery.scheduled_at.toISOString()).toBe(when);
  });

  it("when=<past ISO> is rejected (422), nothing enqueued [PSA47]", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await fixtures();
    const when = new Date(Date.now() - 3_600_000).toISOString();
    await expect(publishPost({ postId, channelId, when }, WS, fakeRegister)).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS))).toHaveLength(0);
  });

  it("double-publish -> 409, and exactly one delivery exists", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await fixtures();
    await publishPost({ postId, channelId, when: "now" }, WS, fakeRegister);
    await expect(publishPost({ postId, channelId, when: "now" }, WS, fakeRegister)).rejects.toMatchObject({
      status: 409,
    });
    const deliveries = await db.select().from(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
    expect(deliveries.length).toBe(1);
  });

  it("404 for an unknown post; 422 when the post has no media", async () => {
    if (!TEST_DB) return;
    const { channelId } = await fixtures();
    await expect(publishPost({ postId: randomUUID(), channelId, when: "now" }, WS, fakeRegister)).rejects.toMatchObject({ status: 404 });
    const { postId } = await fixtures({ video_url: null, media_url: null, media_urls: [] });
    await expect(publishPost({ postId, channelId, when: "now" }, WS, fakeRegister)).rejects.toMatchObject({ status: 422 });
  });

  it("respects a format override", async () => {
    if (!TEST_DB) return;
    const { channelId, postId } = await fixtures();
    const { delivery } = await publishPost({ postId, channelId, when: "now", format: "story" }, WS, fakeRegister);
    expect(delivery.format).toBe("story");
  });

  it("rejects a channel whose platform doesn't match the post (422, nothing enqueued) [PSA44]", async () => {
    if (!TEST_DB) return;
    const [ytCh] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "youtube",
        platform_id: `yt-${Math.random()}`,
        connection_mode: "oauth",
        token_encrypted: encryptTokens({ access_token: "t" }),
        webhook_secret: "wh",
      })
      .returning();
    const { postId } = await fixtures({ platform: "instagram" }); // instagram-authored post → YouTube channel
    await expect(publishPost({ postId, channelId: ytCh!.id, when: "now" }, WS, fakeRegister)).rejects.toMatchObject({
      status: 422,
    });
    expect(await db.select().from(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS))).toHaveLength(0);
  });

  it("accepts a matching instagram post → instagram channel [PSA44]", async () => {
    if (!TEST_DB) return;
    // Trunk reconciliation: facebook/instagram are DISTINCT platforms (no meta+subKind). A matching
    // target for an instagram post is an `instagram` channel.
    const [igCh] = await db
      .insert(schema.channels)
      .values({
        workspace_id: WS,
        platform: "instagram",
        platform_id: `ig-${Math.random()}`,
        connection_mode: "manual_token",
        token_encrypted: encryptTokens({ access_token: "t" }),
        webhook_secret: "wh",
      })
      .returning();
    const { postId } = await fixtures({ platform: "instagram" });
    const { delivery } = await publishPost({ postId, channelId: igCh!.id, when: "now" }, WS, fakeRegister);
    expect(delivery.status).toBe("scheduled");
  });
});
