import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import type { Hono } from "hono";

const { fetchInstagramStoryClips } = vi.hoisted(() => ({ fetchInstagramStoryClips: vi.fn() }));
vi.mock("@/lib/stories/segments", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/stories/segments")>(), fetchInstagramStoryClips }));

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;
let processPublish: typeof import("./publish-worker").processPublish;
let metaProvider: typeof import("@/lib/providers/meta").metaProvider;
let TransientError: typeof import("@/lib/providers/errors").TransientError;
let workspaceId: string;
const key = "sk_live_story_split_integration_0123456";
const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;
const clips = [1, 2, 3].map(i => `https://bucket.example/clip-${i}.mp4`);

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  app = (await import("@/server/app")).buildApp();
  ({ processPublish } = await import("./publish-worker"));
  ({ metaProvider } = await import("@/lib/providers/meta"));
  ({ TransientError } = await import("@/lib/providers/errors"));
  workspaceId = await (await import("../../../tests/helpers/workspace")).seedWorkspace(db, s, { slug: `story-split-${Date.now()}` });
  await db.insert(s.apiKeys).values({ workspace_id: workspaceId, name: "story", key_hash: createHash("sha256").update(key).digest("hex"), key_prefix: key.slice(0, 16), scopes: ["posts:write", "posts:read"] });
});
beforeEach(async () => {
  await db.delete(s.posts).where(eq(s.posts.workspace_id, workspaceId));
  await db.delete(s.deliveries).where(eq(s.deliveries.workspace_id, workspaceId));
  await db.delete(s.media).where(eq(s.media.workspace_id, workspaceId));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, workspaceId));
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  fetchInstagramStoryClips.mockReset().mockResolvedValue(clips);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db.delete(s.workspaces).where(eq(s.workspaces.id, workspaceId));
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.$client.end();
});

const post = (path: string, body: unknown) => app.request(`/api/v1${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
async function publishStoryVideo(platform: "instagram" | "facebook", durationSec: number) {
  const { encryptTokens } = await import("@/lib/crypto");
  const [channel] = await db.insert(s.channels).values({ workspace_id: workspaceId, platform, platform_id: "1784", status: "active", connection_mode: "manual_token", token_encrypted: encryptTokens({ access_token: "PAGE_TOKEN" }), webhook_secret: "wh" }).returning();
  await db.insert(s.media).values({ workspace_id: workspaceId, checksum: `c${durationSec}`, storage_key: "k", url: "https://cdn.example/long", kind: "video", duration_sec: durationSec });
  const created = await post("/posts", { platform, mediaUrls: ["https://cdn.example/long"], description: "Story" });
  expect(created.status).toBe(201);
  const published = await post(`/posts/${(await created.json()).data.id}/publish`, { channelId: channel!.id, format: "story" });
  expect(published.status).toBe(200);
  return (await published.json()).data as { delivery: { id: string }; storySegments: number | null };
}
const delivery = (id: string) => db.query.deliveries.findFirst({ where: and(eq(s.deliveries.id, id), eq(s.deliveries.workspace_id, workspaceId)) });

describe("Instagram Story video over 60 s", () => {
  it("API reports the clip count; the worker publishes the clips in order and a retry never repeats a published clip", async () => {
    const result = await publishStoryVideo("instagram", 125);
    expect(result.storySegments).toBe(3);
    const pub = vi.spyOn(metaProvider, "publishStory")
      .mockResolvedValueOnce({ providerHandle: "S1" })
      .mockRejectedValueOnce(new TransientError("container not ready", "pre_commit"))
      .mockResolvedValueOnce({ providerHandle: "S2" })
      .mockResolvedValueOnce({ providerHandle: "S3" });

    await processPublish({ postId: result.delivery.id }, helpers);
    expect(await delivery(result.delivery.id)).toMatchObject({ status: "scheduled", payload: { _storyClipHandles: ["S1"] } });
    await db.update(s.deliveries).set({ scheduled_at: new Date(Date.now() - 1000) }).where(eq(s.deliveries.id, result.delivery.id));
    await processPublish({ postId: result.delivery.id }, helpers);
    await processPublish({ postId: result.delivery.id }, helpers);

    expect(pub.mock.calls.map(call => call[0].mediaUrl)).toEqual([clips[0], clips[1], clips[1], clips[2]]);
    expect(pub.mock.calls[0]![0]).toMatchObject({ accountId: "1784", mediaKind: "video", channelMetadata: { subKind: "instagram" } });
    expect(fetchInstagramStoryClips).toHaveBeenCalledWith("https://cdn.example/long", `stories/${result.delivery.id}`);
    expect(await delivery(result.delivery.id)).toMatchObject({ status: "sent", provider_handle: "S1", payload: { _storyClipHandles: ["S1", "S2", "S3"] } });
  });

  it("publishes a 60 s video as one Story without splitting", async () => {
    const result = await publishStoryVideo("instagram", 60);
    expect(result.storySegments).toBe(1);
    const pub = vi.spyOn(metaProvider, "publishStory").mockResolvedValue({ providerHandle: "ONE" });
    await processPublish({ postId: result.delivery.id }, helpers);
    expect(fetchInstagramStoryClips).not.toHaveBeenCalled();
    expect(pub).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mediaUrl: "https://cdn.example/long" }));
    expect((await delivery(result.delivery.id))?.status).toBe("sent");
  });

  it("does not split Facebook Stories", async () => {
    const result = await publishStoryVideo("facebook", 120);
    expect(result.storySegments).toBeNull();
    const pub = vi.spyOn(metaProvider, "publishStory").mockResolvedValue({ providerHandle: "FB" });
    await processPublish({ postId: result.delivery.id }, helpers);
    expect(fetchInstagramStoryClips).not.toHaveBeenCalled();
    expect(pub).toHaveBeenCalledOnce();
  });
});
