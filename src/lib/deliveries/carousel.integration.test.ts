import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { JobHelpers } from "graphile-worker";
import type { Hono } from "hono";
import videoFixture from "@/lib/providers/__fixtures__/facebook-video-carousel.json";
import fixture from "@/lib/providers/__fixtures__/meta-carousel.json";
import { replayFetch } from "@/lib/providers/__fixtures__/recorded/replay";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;
let processPublish: typeof import("./publish-worker").processPublish;
let workspaceId: string;
const key = "sk_live_carousel_integration_0123456789";
const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const helpers = { logger: { info() {}, error() {} } } as unknown as JobHelpers;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  app = (await import("@/server/app")).buildApp();
  ({ processPublish } = await import("./publish-worker"));
  workspaceId = await (await import("../../../tests/helpers/workspace")).seedWorkspace(db, s, { slug: `carousel-${Date.now()}` });
  await db.insert(s.apiKeys).values({ workspace_id: workspaceId, name: "carousel", key_hash: createHash("sha256").update(key).digest("hex"), key_prefix: key.slice(0, 16), scopes: ["posts:write", "posts:read"] });
});
beforeEach(async () => {
  await db.delete(s.posts).where(eq(s.posts.workspace_id, workspaceId));
  await db.delete(s.deliveries).where(eq(s.deliveries.workspace_id, workspaceId));
  await db.delete(s.media).where(eq(s.media.workspace_id, workspaceId));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, workspaceId));
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  vi.stubEnv("META_PUBLISH_POLL_DELAY_MS", "0");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await db.delete(s.workspaces).where(eq(s.workspaces.id, workspaceId));
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.$client.end();
});
const post = (path: string, body: unknown) => app.request(`/api/v1${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
async function scenario(platform: "facebook" | "instagram", kinds = ["image", "image"]) {
  const { encryptTokens } = await import("@/lib/crypto");
  const [channel] = await db.insert(s.channels).values({ workspace_id: workspaceId, platform, platform_id: platform === "facebook" ? "125730403827906" : "60596468270350638", status: "active", connection_mode: "manual_token", token_encrypted: encryptTokens(platform === "instagram" ? { access_token: "", messaging_token: "IG_LOGIN_TOKEN" } : { access_token: "PAGE_TOKEN" }), webhook_secret: "wh" }).returning();
  const mediaUrls = [];
  for (const [i, kind] of kinds.entries()) {
    // The URL deliberately has no useful extension: the registry is the source of media kinds.
    const url = `https://cdn.example/${i}`; mediaUrls.push(url);
    await db.insert(s.media).values({ workspace_id: workspaceId, checksum: String(i), storage_key: String(i), url, kind });
  }
  const res = await post("/posts", { platform, mediaUrls, description: "Slides" });
  expect(res.status).toBe(201);
  return { channelId: channel!.id, postId: (await res.json()).data.id as string, mediaUrls };
}
const delivery = (id: string) => db.query.deliveries.findFirst({ where: and(eq(s.deliveries.id, id), eq(s.deliveries.workspace_id, workspaceId)) });

describe("carousel API and publish worker", () => {
  it.each(["facebook", "instagram", "facebook_video"] as const)("publishes all %s slides once through API → worker", async mode => {
    const platform = mode === "facebook_video" ? "facebook" : mode;
    const input = await scenario(platform, platform === "instagram" || mode === "facebook_video" ? ["image", "video"] : undefined);
    if (mode === "facebook_video") await db.update(s.channels).set({ video_carousel: "available" }).where(and(eq(s.channels.id, input.channelId), eq(s.channels.workspace_id, workspaceId)));
    const published = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
    expect(published.status).toBe(200);
    const d = (await published.json()).data.delivery;
    expect(d.format).toBe("carousel"); expect(d.payload.media).toHaveLength(2);
    const { calls } = replayFetch(platform === "facebook" ? (mode === "facebook_video" ? [fixture.facebook[0], ...videoFixture.videoReady, fixture.facebook[2]] : fixture.facebook) : fixture.instagram.map(e => ({ ...e, url: e.url.replace("graph.facebook.com", "graph.instagram.com") })));
    await processPublish({ postId: d.id }, helpers);
    expect((await delivery(d.id))!.status).toBe("sent");
    const p = await db.query.posts.findFirst({ where: and(eq(s.posts.workspace_id, workspaceId), eq(s.posts.id, input.postId)) });
    expect(p!.published_url).toBe(platform === "facebook" ? "https://www.facebook.com/125730403827906/posts/1002088850000" : "https://www.instagram.com/p/ABC123/");
    const count = calls.length;
    await processPublish({ postId: d.id }, helpers);
    expect(calls).toHaveLength(count);
    expect((await post(`/posts/${input.postId}/publish`, { channelId: input.channelId })).status).toBe(409);
  });

  it("accepts ten image slides without dropping any", async () => {
    const input = await scenario("instagram", Array.from({ length: 10 }, () => "image"));
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
    expect(response.status).toBe(200);
    expect((await response.json()).data.delivery.payload.media).toHaveLength(10);
  });

  it("returns 422 for FB video without creating a delivery", async () => {
    const input = await scenario("facebook", ["image", "video"]);
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId, format: "carousel" });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("Video in Facebook carousels requires a verified Meta app with ads permission (pages_manage_ads) for this Page.");
    expect(await db.query.deliveries.findMany({ where: eq(s.deliveries.workspace_id, workspaceId) })).toEqual([]);
  });

  it("returns 422 while a Facebook carousel item has not been identified yet", async () => {
    const input = await scenario("facebook");
    await db.update(s.media).set({ kind: "", status: "ingesting" }).where(and(eq(s.media.workspace_id, workspaceId), eq(s.media.url, input.mediaUrls[1])));
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("wait until ready");
    expect(await db.query.deliveries.findMany({ where: eq(s.deliveries.workspace_id, workspaceId) })).toEqual([]);
  });

  it.each([1, 11])("returns 422 for %s carousel items", async n => {
    const input = await scenario("instagram", Array.from({ length: n }, () => "image"));
    expect((await post(`/posts/${input.postId}/publish`, { channelId: input.channelId, format: "carousel" })).status).toBe(422);
  });

  it("keeps all media refs on a caption edit and rejects FB video replacement", async () => {
    const input = await scenario("facebook");
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId, when: new Date(Date.now() + 3600_000).toISOString() });
    expect(response.status).toBe(200);
    const d = (await response.json()).data.delivery;
    const patch = (body: unknown) => app.request(`/api/v1/posts/${input.postId}`, { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    expect((await patch({ description: "New caption" })).status).toBe(200);
    expect((await delivery(d.id))!.payload).toMatchObject({ format: "carousel", media: d.payload.media, caption: "New caption" });
    await db.insert(s.media).values({ workspace_id: workspaceId, checksum: "video", storage_key: "v", url: "https://cdn.example/video", kind: "video" });
    expect((await patch({ mediaUrls: [input.mediaUrls[0], "https://cdn.example/video"] })).status).toBe(422);
    expect((await delivery(d.id))!.payload).toMatchObject({ media: d.payload.media });
  });

  it("safely retries a child failure then publishes one post", async () => {
    const input = await scenario("facebook");
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
    const d = (await response.json()).data.delivery;
    const first = replayFetch([fixture.facebook[0], { ...fixture.facebook[1], status: 503, body: {} }, { method: "DELETE", url: "https://graph.facebook.com/v26.0/554158337282822679", status: 200, body: { success: true } }]);
    await processPublish({ postId: d.id }, helpers);
    expect((await delivery(d.id))!.status).toBe("scheduled");
    expect(first.calls.some(c => c.url.endsWith("/feed"))).toBe(false);
    const second = replayFetch(fixture.facebook);
    await processPublish({ postId: d.id }, helpers);
    expect((await delivery(d.id))!.status).toBe("sent");
    expect(second.calls.filter(c => c.url.endsWith("/feed"))).toHaveLength(1);
  });

  it.each(["facebook", "instagram", "facebook_video"] as const)("does not repeat an uncertain %s commit", async mode => {
    const platform = mode === "facebook_video" ? "facebook" : mode;
    const input = await scenario(platform, mode === "facebook_video" ? ["image", "video"] : undefined);
    if (mode === "facebook_video") await db.update(s.channels).set({ video_carousel: "available" }).where(and(eq(s.channels.id, input.channelId), eq(s.channels.workspace_id, workspaceId)));
    const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
    const d = (await response.json()).data.delivery;
    const exchanges = platform === "facebook" ? (mode === "facebook_video" ? [fixture.facebook[0], ...videoFixture.videoReady, fixture.facebook[2]] : fixture.facebook) : fixture.instagram.map(e => ({ ...e, url: e.url.replace("graph.facebook.com", "graph.instagram.com") }));
    const { calls } = replayFetch(exchanges.map(e => /\/(feed|media_publish)$/.test(e.url) ? { ...e, status: 503, body: {} } : e));
    await expect(processPublish({ postId: d.id }, helpers)).rejects.toThrow();
    expect((await delivery(d.id))!.status).toBe("sending");
    const count = calls.length;
    await processPublish({ postId: d.id }, helpers);
    expect((await delivery(d.id))!.status).toBe("unknown");
    expect(calls).toHaveLength(count);
  });
});

it("schedules Facebook video for an available channel and validates edits with that channel", async () => {
  const input = await scenario("facebook", ["image", "video"]);
  await db.update(s.channels).set({ video_carousel: "available" }).where(and(eq(s.channels.id, input.channelId), eq(s.channels.workspace_id, workspaceId)));
  const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId, when: new Date(Date.now() + 3600_000).toISOString() });
  expect(response.status).toBe(200);
  const patch = await app.request(`/api/v1/posts/${input.postId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ description: "Updated video carousel" }) });
  expect(patch.status).toBe(200);
});

it("stops a scheduled video carousel if the channel no longer has access", async () => {
  const input = await scenario("facebook", ["image", "video"]);
  const channelWhere = and(eq(s.channels.id, input.channelId), eq(s.channels.workspace_id, workspaceId));
  await db.update(s.channels).set({ video_carousel: "available" }).where(channelWhere);
  const response = await post(`/posts/${input.postId}/publish`, { channelId: input.channelId });
  expect(response.status).toBe(200);
  const d = (await response.json()).data.delivery;
  await db.update(s.channels).set({ video_carousel: "unavailable" }).where(channelWhere);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await processPublish({ postId: d.id }, helpers);
  expect((await delivery(d.id))!.status).toBe("failed");
  expect(fetch).not.toHaveBeenCalled();
});
