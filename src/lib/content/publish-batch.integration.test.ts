import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let publishPosts: typeof import("./publish-batch").publishPosts;
let resolveBrandChannelForPost: typeof import("./publish-batch").resolveBrandChannelForPost;
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
  ({ publishPosts, resolveBrandChannelForPost } = await import("./publish-batch"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  WS = await seedWorkspace(db, schema, { slug: `pub-batch-${Date.now()}` });

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
  await wipe();
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

async function wipe() {
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  // detach brand FK before removing brands
  await db.update(schema.channels).set({ brand_key: null }).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
  await db.delete(schema.brands).where(eq(schema.brands.workspace_id, WS));
}

beforeEach(async () => {
  if (!TEST_DB) return;
  await wipe();
});

// A brand-owned channel for `platform` (trunk: facebook/instagram are distinct platforms, matched
// exactly — no meta+subKind). The brand_key joins it to the brand for resolution.
async function brandChannel(brandKey: string, platform: "instagram" | "facebook" | "tiktok"): Promise<string> {
  const [ch] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform,
      platform_id: `acct-${Math.random()}`,
      connection_mode: "manual_token",
      token_encrypted: encryptTokens({ access_token: "t" }),
      webhook_secret: "wh",
      brand_key: brandKey,
    })
    .returning({ id: schema.channels.id });
  return ch!.id;
}

async function plannedPost(contentId: string, platform: string): Promise<string> {
  const [p] = await db
    .insert(schema.posts)
    .values({ workspace_id: WS, content_id: contentId, platform, video_url: "https://cdn/x.mp4", status: "planned" })
    .returning({ id: schema.posts.id });
  return p!.id;
}

describe("resolveBrandChannelForPost", () => {
  it("resolves via content.profile → brand → channel", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.brands).values({ workspace_id: WS, key: "tsa", name: "TSA" });
    const ch = await brandChannel("tsa", "instagram");
    const [c] = await db.insert(schema.content).values({ workspace_id: WS, title: "X", profile: "tsa" }).returning();
    const post = await plannedPost(c!.id, "instagram");
    const r = await resolveBrandChannelForPost(post, WS);
    expect(r).toMatchObject({ channelId: ch });
  });

  it("reports a reason when the content has no brand", async () => {
    if (!TEST_DB) return;
    const [c] = await db.insert(schema.content).values({ workspace_id: WS, title: "X" }).returning();
    const post = await plannedPost(c!.id, "instagram");
    expect(await resolveBrandChannelForPost(post, WS)).toMatchObject({ reason: expect.stringContaining("no brand") });
  });

  it("reports a reason when the platform slot is unmapped", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.brands).values({ workspace_id: WS, key: "tsa", name: "TSA" });
    const [c] = await db.insert(schema.content).values({ workspace_id: WS, title: "X", profile: "tsa" }).returning();
    const post = await plannedPost(c!.id, "tiktok");
    expect(await resolveBrandChannelForPost(post, WS)).toMatchObject({ reason: expect.stringContaining("tiktok") });
  });
});

describe("publishPosts (batch)", () => {
  it("publishes the mapped posts and reports the unmapped ones — best effort", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.brands).values({ workspace_id: WS, key: "tsa", name: "TSA" });
    await brandChannel("tsa", "instagram");
    await brandChannel("tsa", "facebook");
    const [c] = await db.insert(schema.content).values({ workspace_id: WS, title: "X", profile: "tsa", content_type: "reel" }).returning();
    const ig = await plannedPost(c!.id, "instagram");
    const fb = await plannedPost(c!.id, "facebook");
    const tt = await plannedPost(c!.id, "tiktok"); // no tiktok channel mapped

    const results = await publishPosts([ig, fb, tt], "now", WS, fakeRegister);
    const byId = Object.fromEntries(results.map((r) => [r.postId, r]));
    expect(byId[ig]!.ok).toBe(true);
    expect(byId[fb]!.ok).toBe(true);
    expect(byId[tt]!.ok).toBe(false);

    const igRow = await db.query.posts.findFirst({ where: eq(schema.posts.id, ig) });
    expect(igRow!.status).toBe("scheduled");
    expect(igRow!.delivery_id).not.toBeNull();
    const ttRow = await db.query.posts.findFirst({ where: eq(schema.posts.id, tt) });
    expect(ttRow!.status).toBe("planned"); // untouched
    expect(await db.select().from(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS))).toHaveLength(2);
  });

  it("schedules at a future ISO when given one", async () => {
    if (!TEST_DB) return;
    await db.insert(schema.brands).values({ workspace_id: WS, key: "tsa", name: "TSA" });
    await brandChannel("tsa", "instagram");
    const [c] = await db.insert(schema.content).values({ workspace_id: WS, title: "X", profile: "tsa", content_type: "reel" }).returning();
    const ig = await plannedPost(c!.id, "instagram");
    const when = new Date(Date.now() + 3_600_000).toISOString();
    await publishPosts([ig], when, WS, fakeRegister);
    const d = await db.query.deliveries.findFirst({ where: eq(schema.deliveries.workspace_id, WS) });
    expect(d!.scheduled_at.toISOString()).toBe(when);
  });
});
