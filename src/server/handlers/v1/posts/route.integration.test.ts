import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

const { licensed } = vi.hoisted(() => ({ licensed: { value: false } }));
vi.mock("@/lib/license/gate", async (original) => ({
  ...await original<typeof import("@/lib/license/gate")>(),
  hasFeature: vi.fn(async () => licensed.value),
}));

vi.mock("@/lib/media/service", async (original) => ({
  ...await original<typeof import("@/lib/media/service")>(),
  registerByUrl: vi.fn(),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_posts_key_abcd000000000001";
const OTHER_KEY = "sk_live_posts_other_abcd0000000002";
const READ_KEY = "sk_live_posts_read_abcd00000000003";
const WRITE_KEY = "sk_live_posts_write_abcd0000000004";
const UNRELATED_KEY = "sk_live_posts_unrelated_abcd000005";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;

const WS = "c0ffee08-0000-4000-8000-000000000d01";
const OTHER_WS = "c0ffee08-0000-4000-8000-000000000d02";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("@/server/app");
  app = buildApp();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  licensed.value = false;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.insert(s.workspaces).values([
    { id: WS, name: "W", slug: `w-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await db.insert(s.apiKeys).values([
    { workspace_id: WS, name: "k", key_hash: hash(KEY), key_prefix: "sk_live_ps" },
    { workspace_id: WS, name: "reader", key_hash: hash(READ_KEY), key_prefix: "sk_live_pr", scopes: ["posts:read"] },
    { workspace_id: WS, name: "writer", key_hash: hash(WRITE_KEY), key_prefix: "sk_live_pw", scopes: ["posts:write"] },
    { workspace_id: WS, name: "unrelated", key_hash: hash(UNRELATED_KEY), key_prefix: "sk_live_pu", scopes: ["stats:read"] },
    { workspace_id: OTHER_WS, name: "o", key_hash: hash(OTHER_KEY), key_prefix: "sk_live_po" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.$client.end();
});

function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createOne(over: Record<string, unknown> = {}, key = KEY) {
  const res = await call("POST", "/posts", { platform: "instagram", description: "hi", ...over }, key);
  return { res, json: await res.json() };
}

async function deliveryFixture(workspaceId = WS, key = KEY, text: string | null = "Comment", id?: string) {
  const { json } = await createOne({ firstComment: text }, key);
  const [channel] = await db.insert(s.channels).values({
    workspace_id: workspaceId, platform: "instagram", platform_id: json.data.id,
    token_encrypted: "unused", webhook_secret: "unused",
  }).returning();
  const [delivery] = await db.insert(s.deliveries).values({
    id,
    workspace_id: workspaceId, channel_id: channel!.id, format: "reel",
    payload: { firstComment: text }, scheduled_at: new Date("2030-01-02T08:30:00.000Z"),
    updated_at: new Date("2030-01-02T09:00:00.000Z"),
  }).returning();
  await db.update(s.posts).set({ delivery_id: delivery!.id }).where(eq(s.posts.id, json.data.id));
  return { postId: json.data.id as string, delivery: delivery!, channelId: channel!.id };
}

describe.skipIf(!TEST_DB)("/api/v1/posts", () => {
  it.each(["scheduled", "held"] as const)("PATCH updates the %s publish payload consumed by the worker", async (status) => {
    const { postId, delivery } = await deliveryFixture();
    const [asset] = await db.insert(s.media).values({ workspace_id: WS, checksum: "original", storage_key: "old", url: "https://example.com/old.mp4", kind: "video" }).returning();
    const [replacement] = await db.insert(s.media).values({ workspace_id: WS, checksum: "replacement", storage_key: "new", url: "https://example.com/new.mp4", kind: "video" }).returning();
    await db.update(s.posts).set({ status: "scheduled", video_url: asset!.url, cover_url: "https://example.com/old.jpg", hashtags: "#sale" }).where(eq(s.posts.id, postId));
    await db.update(s.deliveries).set({ status, payload: { format: "reel", media: [{ mediaId: asset!.id }], caption: "old", options: { keepOption: true, coverUrl: "https://example.com/old.jpg" } } }).where(eq(s.deliveries.id, delivery.id));
    const { registerByUrl } = await import("@/lib/media/service");
    vi.mocked(registerByUrl).mockClear().mockResolvedValue(replacement!);
    expect((await call("PATCH", `/posts/${postId}`, { description: "Price 99", firstComment: "Details" })).status).toBe(200);
    expect(registerByUrl).not.toHaveBeenCalled();
    expect((await call("PATCH", `/posts/${postId}`, { description: "x".repeat(3000), scheduledDate: "2031-01-01T00:00:00.000Z" })).status).toBe(422);
    expect((await db.query.posts.findFirst({ where: eq(s.posts.id, postId) }))!.description).toBe("Price 99");
    expect((await db.query.deliveries.findFirst({ where: eq(s.deliveries.id, delivery.id) }))!.scheduled_at).toEqual(delivery.scheduled_at);
    let changed = await db.query.deliveries.findFirst({ where: eq(s.deliveries.id, delivery.id) });
    expect(changed!.payload).toMatchObject({ caption: "Price 99\n\n#sale", firstComment: "Details", media: [{ mediaId: asset!.id }], options: { keepOption: true } });
    expect((await call("PATCH", `/posts/${postId}`, { videoUrl: replacement!.url, firstComment: null, coverUrl: null })).status).toBe(200);
    expect(registerByUrl).toHaveBeenCalledOnce();
    changed = await db.query.deliveries.findFirst({ where: eq(s.deliveries.id, delivery.id) });
    expect(changed!.payload).toMatchObject({ caption: "Price 99\n\n#sale", media: [{ mediaId: replacement!.id }] });
    expect(changed!.payload).not.toHaveProperty("firstComment");
    expect(changed!.payload).not.toHaveProperty("options.coverUrl");
    await db.update(s.deliveries).set({ status: "sending" }).where(eq(s.deliveries.id, delivery.id));
    const late = await call("PATCH", `/posts/${postId}`, { description: "late" });
    expect(late.status).toBe(409);
    expect((await late.json()).error.message).toContain("already publishing");
    expect((await db.query.posts.findFirst({ where: eq(s.posts.id, postId) }))!.description).toBe("Price 99");
  });
  it("waits for a delivery claim and rejects the edit after it becomes sending", async () => {
    const { postId, delivery } = await deliveryFixture();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const claiming = db.transaction(async (tx) => {
      await tx.update(s.deliveries).set({ status: "sending" }).where(eq(s.deliveries.id, delivery.id));
      ready();
      await gate;
    });
    await entered;
    const editing = call("PATCH", `/posts/${postId}`, { description: "Changed after claim" });
    try {
      const { sql } = await import("drizzle-orm");
      await vi.waitFor(async () => {
        const locks = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%deliveries%'`);
        expect(locks.rows[0].n).toBeGreaterThan(0);
      });
      release();
      await claiming;
      expect((await editing).status).toBe(409);
      expect((await db.query.posts.findFirst({ where: eq(s.posts.id, postId) }))!.description).toBe("hi");
    } finally { release(); await claiming; await editing; }
  });
  it.each(["cancel", "publish-now"])("%s requires a write scope and keeps TikTok confirmation", async (action) => {
    const { delivery } = await deliveryFixture();
    expect((await call("POST", `/deliveries/${delivery.id}/${action}`, undefined, null)).status).toBe(401);
    expect((await call("POST", `/deliveries/${delivery.id}/${action}`, undefined, READ_KEY)).status).toBe(401);
    await db.update(s.deliveries).set({ tiktok_confirmation: "required", status: "held" }).where(eq(s.deliveries.id, delivery.id));
    expect((await call("POST", `/deliveries/${delivery.id}/${action}`)).status).toBe(action === "cancel" ? 204 : 409);
  });
  it("cancel resets the editorial post and exposes delivery on nested content posts", async () => {
    const content = (await (await call("POST", "/content", { title: "Scheduled campaign" })).json()).data;
    const { postId, delivery, channelId } = await deliveryFixture();
    await db.update(s.posts).set({ content_id: content.id, status: "scheduled" }).where(eq(s.posts.id, postId));
    const before = (await (await call("GET", `/content/${content.id}`)).json()).data.posts[0];
    expect(before.delivery).toMatchObject({ id: delivery.id, status: "scheduled", scheduledFor: "2030-01-02T08:30:00.000Z" });
    expect((await call("POST", `/deliveries/${delivery.id}/cancel`, undefined, OTHER_KEY)).status).toBe(404);
    expect((await call("POST", `/deliveries/${delivery.id}/cancel`)).status).toBe(204);
    for (const row of [
      (await (await call("GET", `/posts/${postId}`)).json()).data,
      (await (await call("GET", `/content/${content.id}`)).json()).data.posts[0],
    ]) expect(row).toMatchObject({ status: "planned", deliveryId: null, delivery: null });
    expect((await call("POST", `/deliveries/${delivery.id}/cancel`)).status).toBe(409);
    const [asset] = await db.insert(s.media).values({ workspace_id: WS, checksum: "republish", storage_key: "republish", url: "https://example.com/reel.mp4", kind: "video" }).returning();
    await db.update(s.posts).set({ video_url: asset!.url }).where(eq(s.posts.id, postId));
    const { registerByUrl } = await import("@/lib/media/service");
    vi.mocked(registerByUrl).mockResolvedValue(asset!);
    expect((await call("POST", `/posts/${postId}/publish`, { channelId, when: "2030-01-03T08:30:00.000Z" })).status).toBe(200);
  });
  it.each(["scheduled", "held"] as const)("publish-now reuses one job for %s and rejects deliveries that are sending", async (status) => {
    const { delivery } = await deliveryFixture();
    expect((await call("POST", `/deliveries/${delivery.id}/publish-now`, undefined, OTHER_KEY)).status).toBe(404);
    await db.update(s.deliveries).set({ status }).where(eq(s.deliveries.id, delivery.id));
    const results = await Promise.all([1, 2].map(() => call("POST", `/deliveries/${delivery.id}/publish-now`)));
    expect(results.map(r => r.status)).toEqual([200, 200]);
    const { sql } = await import("drizzle-orm");
    const jobs = await db.execute(sql`select * from graphile_worker.jobs where key = ${`publish:${delivery.id}`}`);
    expect(jobs.rows).toHaveLength(1);
    expect(new Date(jobs.rows[0].run_at as string).getTime()).toBeLessThanOrEqual(Date.now());
    await db.update(s.deliveries).set({ status: "sending" }).where(eq(s.deliveries.id, delivery.id));
    expect((await call("POST", `/deliveries/${delivery.id}/publish-now`)).status).toBe(409);
    const res = await call("PATCH", `/posts/${(await db.query.posts.findFirst({ where: eq(s.posts.delivery_id, delivery.id) }))!.id}`, { description: "too late" });
    expect(res.status).toBe(409);
  });
  it("persists TikTok choices through create, list, read and patch with workspace isolation", async () => {
    const options = { tiktokPublishMode: "direct", tiktokPrivacyLevel: "PUBLIC_TO_EVERYONE", tiktokDisableComment: false, tiktokDisableDuet: true, tiktokDisableStitch: false, tiktokBrandContentToggle: true, tiktokBrandOrganicToggle: false, tiktokCoverTimestampMs: 1234 };
    const { res, json } = await createOne({ platform: "tiktok", ...options });
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject(options);
    expect((await (await call("GET", `/posts/${json.data.id}`)).json()).data).toMatchObject(options);
    expect((await (await call("GET", "/posts")).json()).data.items[0]).toMatchObject(options);
    expect((await call("PATCH", `/posts/${json.data.id}`, { tiktokPrivacyLevel: "SELF_ONLY" }, OTHER_KEY)).status).toBe(404);
    const cleared = await (await call("PATCH", `/posts/${json.data.id}`, { tiktokPrivacyLevel: null, tiktokBrandContentToggle: false })).json();
    expect(cleared.data).toMatchObject({ tiktokPrivacyLevel: null, tiktokPublishMode: "direct", tiktokBrandContentToggle: false });
  });
  it.each([{ tiktokPrivacyLevel: "invalid" }, { tiktokPublishMode: "auto" }, { tiktokDisableComment: "false" }, { tiktokCoverTimestampMs: -1 }])("rejects invalid TikTok options %j", async options => {
    expect((await createOne({ platform: "tiktok", ...options })).res.status).toBe(422);
  });

  it("requires content from the post workspace on create", async () => {
    const content = await (await call("POST", "/content", { title: "Shared material" })).json();
    const contentId = content.data.id;
    const rejected = await createOne({ contentId }, OTHER_KEY);
    expect(rejected.res.status).toBe(404);
    expect(await db.query.posts.findMany({ where: eq(s.posts.workspace_id, OTHER_WS) })).toHaveLength(0);
    const own = await createOne({ contentId });
    expect(own.res.status).toBe(201);
    const detail = await (await call("GET", `/content/${contentId}`)).json();
    expect(detail.data.posts.map((p: { id: string }) => p.id)).toEqual([own.json.data.id]);
  });

  it("keeps the post unchanged when its requested content is unavailable", async () => {
    const content = await (await call("POST", "/content", { title: "Material" })).json();
    const contentId = content.data.id;
    const other = await createOne({}, OTHER_KEY);
    const patch = await call("PATCH", `/posts/${other.json.data.id}`, { contentId, description: "changed" }, OTHER_KEY);
    expect(patch.status).toBe(404);
    const unchanged = await (await call("GET", `/posts/${other.json.data.id}`, undefined, OTHER_KEY)).json();
    expect(unchanged.data).toMatchObject({ contentId: null, description: "hi" });
    const own = await createOne();
    expect((await call("PATCH", `/posts/${own.json.data.id}`, { description: "updated" })).status).toBe(200);
    expect((await call("PATCH", `/posts/${own.json.data.id}`, { contentId })).status).toBe(200);
    const detail = await (await call("GET", `/content/${contentId}`)).json();
    expect(detail.data.posts.map((p: { id: string }) => p.id)).toEqual([own.json.data.id]);
  });

  it("returns 404 for an unavailable content reference", async () => {
    const { res } = await createOne({ contentId: "00000000-0000-4000-8000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("scopes related posts when reading content", async () => {
    const content = await (await call("POST", "/content", { title: "Material" })).json();
    const own = await createOne({ contentId: content.data.id });
    await db.insert(s.posts).values({ workspace_id: OTHER_WS, content_id: content.data.id, platform: "instagram", description: "Other post" });
    const detail = await (await call("GET", `/content/${content.data.id}`)).json();
    expect(detail.data.posts.map((p: { id: string }) => p.id)).toEqual([own.json.data.id]);
  });

  it("returns null delivery before publishing", async () => {
    const { json } = await createOne();
    const detail = await (await call("GET", `/posts/${json.data.id}`)).json();
    expect(detail.data.delivery).toBeNull();
  });

  it("reads the requested schedule after publishing", async () => {
    const f = await deliveryFixture();
    await db.update(s.posts).set({ delivery_id: null, video_url: "https://cdn.test/video.mp4" }).where(eq(s.posts.id, f.postId));
    const { publishPost } = await import("@/lib/content/publish");
    const when = "2030-01-02T08:30:00.000Z";
    await publishPost({ postId: f.postId, channelId: f.channelId, when }, WS, {
      registerMedia: async (url, workspaceId) => {
        const [media] = await db.insert(s.media).values({
          workspace_id: workspaceId, checksum: f.postId, storage_key: "test", kind: "video", url,
        }).returning();
        return { id: media!.id };
      },
    });
    const detail = await (await call("GET", `/posts/${f.postId}`, undefined, READ_KEY)).json();
    expect(detail.data.scheduledDate).toBe(when);
    expect(detail.data.delivery).toMatchObject({
      channelId: f.channelId, status: "scheduled", scheduledFor: when,
      firstComment: { status: "not_attempted", reason: "awaiting_publish", commentId: null, attempts: 0, lastError: null },
    });
  });

  it("reads sent and failed first comments with delivery details", async () => {
    const f = await deliveryFixture(WS, KEY, "Comment", "c0ffee08-0000-4000-8000-000000000d03");
    await db.update(s.deliveries).set({
      status: "sent", provider_handle: "platform-post-1", attempts: 1,
      last_error: "access_token=fake_delivery_token",
      updated_at: new Date("2030-01-02T09:00:00.000Z"),
    }).where(eq(s.deliveries.id, f.delivery.id));
    const [comment] = await db.insert(s.outboundDeliveries).values({
      workspace_id: WS, channel_id: f.channelId, delivery_key: `first-comment:${f.delivery.id}`,
      task_name: "outgoing-first-comment", payload: {}, status: "sent",
      platform_message_id: "comment-1", attempts: 1,
    }).returning();
    const detail = await (await call("GET", `/posts/${f.postId}`)).json();
    expect(detail.data.delivery).toEqual({
      id: "c0ffee08-0000-4000-8000-000000000d03", channelId: f.channelId, status: "sent", scheduledFor: "2030-01-02T08:30:00.000Z",
      attempts: 1, lastError: "access_token=[REDACTED]", platformPostId: "platform-post-1",
      updatedAt: "2030-01-02T09:00:00.000Z",
      firstComment: { status: "sent", commentId: "comment-1", attempts: 1, lastError: null },
    });
    await db.update(s.outboundDeliveries).set({
      status: "failed", last_error: "Bearer fake_comment_token", platform_message_id: null, attempts: 2,
    }).where(eq(s.outboundDeliveries.id, comment!.id));
    const failed = await (await call("GET", `/posts/${f.postId}`)).json();
    expect(failed.data.delivery.firstComment).toEqual({
      status: "failed", commentId: null, attempts: 2, lastError: "Bearer [REDACTED]",
    });
  });

  it("evaluates missing first-comment rows using current settings", async () => {
    const f = await deliveryFixture();
    await db.update(s.deliveries).set({ status: "sent" }).where(eq(s.deliveries.id, f.delivery.id));
    const read = async () => (await (await call("GET", `/posts/${f.postId}`)).json()).data.delivery.firstComment;
    expect(await read()).toEqual({
      status: "not_attempted", reason: "unlicensed", commentId: null, attempts: 0, lastError: null,
    });
    await db.update(s.deliveries).set({ payload: { firstComment: " " } }).where(eq(s.deliveries.id, f.delivery.id));
    expect(await read()).toMatchObject({ status: "not_attempted", reason: "no_text" });
    licensed.value = true;
    await db.update(s.deliveries).set({ payload: { firstComment: "comment" } }).where(eq(s.deliveries.id, f.delivery.id));
    expect(await read()).toEqual({ status: "not_attempted", commentId: null, attempts: 0, lastError: null });
    await db.update(s.channels).set({ platform: "linkedin" }).where(eq(s.channels.id, f.channelId));
    expect(await read()).toMatchObject({ status: "not_attempted", reason: "unsupported_platform" });
  });

  it("lists each delivery only within its workspace", async () => {
    const a = await deliveryFixture();
    const b = await deliveryFixture(OTHER_WS, OTHER_KEY);
    const draft = await createOne({}, OTHER_KEY);
    await db.update(s.deliveries).set({ status: "sent" }).where(eq(s.deliveries.id, b.delivery.id));
    await db.insert(s.outboundDeliveries).values({
      workspace_id: WS, channel_id: a.channelId, delivery_key: `first-comment:${b.delivery.id}`,
      task_name: "outgoing-first-comment", payload: {}, status: "sent", platform_message_id: "other-comment",
    });
    expect((await call("GET", `/posts/${a.postId}`, undefined, OTHER_KEY)).status).toBe(404);
    const list = await (await call("GET", "/posts", undefined, OTHER_KEY)).json();
    expect(list.data.items).toHaveLength(2);
    expect(list.data.items.find((p: { id: string }) => p.id === draft.json.data.id).delivery).toBeNull();
    expect(list.data.items.find((p: { id: string }) => p.id === b.postId).delivery).toMatchObject({
      id: b.delivery.id, status: "sent", firstComment: { status: "not_attempted", reason: "unlicensed" },
    });
    expect(JSON.stringify(list)).not.toContain("other-comment");
    expect(JSON.stringify(list)).not.toContain(a.delivery.id);
    // Even an inconsistent post link must not select a different workspace's ledger.
    await db.update(s.posts).set({ delivery_id: a.delivery.id }).where(eq(s.posts.id, b.postId));
    const detail = await (await call("GET", `/posts/${b.postId}`, undefined, OTHER_KEY)).json();
    expect(detail.data.delivery).toBeNull();
    const second = await deliveryFixture();
    const own = await (await call("GET", "/posts")).json();
    expect(own.data.items.map((p: { delivery: { id: string } }) => p.delivery.id).sort())
      .toEqual([a.delivery.id, second.delivery.id].sort());
  });

  it("keeps an empty-scope key working for post creation", async () => {
    const { res, json } = await createOne();
    expect(res.status).toBe(201);
    expect(json.data).toMatchObject({ platform: "instagram", description: "hi" });
    expect(json.data.id).toBeTruthy();
  });

  it("rejects a post with no platform (422)", async () => {
    expect((await call("POST", "/posts", { description: "no platform" })).status).toBe(422);
  });

  it("lists posts scoped to the workspace", async () => {
    const { json } = await createOne();
    await createOne({}, OTHER_KEY);
    const list = await (await call("GET", "/posts")).json();
    expect(Array.isArray(list.data.items)).toBe(true);
    const ids = list.data.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(json.data.id);
    expect(ids).toHaveLength(1); // OTHER_WS post excluded
  });

  it("GET item; PATCH updates; 404 on unknown", async () => {
    const { json } = await createOne();
    expect((await call("GET", `/posts/${json.data.id}`)).status).toBe(200);
    const patched = await call("PATCH", `/posts/${json.data.id}`, { description: "edited" });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.description).toBe("edited");
    expect((await call("GET", "/posts/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("DELETE removes it (then GET is 404)", async () => {
    const { json } = await createOne();
    expect((await call("DELETE", `/posts/${json.data.id}`)).status).toBe(204);
    expect((await call("GET", `/posts/${json.data.id}`)).status).toBe(404);
  });

  it("publish requires a channelId (422)", async () => {
    const { json } = await createOne();
    expect((await call("POST", `/posts/${json.data.id}/publish`, {})).status).toBe(422);
  });

  it("applies posts:read to list and detail reads", async () => {
    const { json } = await createOne();

    expect((await call("GET", "/posts", undefined, READ_KEY)).status).toBe(200);
    expect((await call("GET", `/posts/${json.data.id}`, undefined, READ_KEY)).status).toBe(200);

    for (const key of [WRITE_KEY, UNRELATED_KEY]) {
      expect((await call("GET", "/posts", undefined, key)).status).toBe(401);
      expect((await call("GET", `/posts/${json.data.id}`, undefined, key)).status).toBe(401);
    }
  });

  it("applies posts:write to create, update, and delete", async () => {
    const { json } = await createOne();

    for (const key of [READ_KEY, UNRELATED_KEY]) {
      const statuses = [
        (await call("POST", "/posts", { platform: "instagram", description: "scoped" }, key)).status,
        (await call("PATCH", `/posts/${json.data.id}`, { description: "scoped" }, key)).status,
        (await call("DELETE", `/posts/${json.data.id}`, undefined, key)).status,
      ];
      expect(statuses).toEqual([401, 401, 401]);
    }

    const created = await createOne({ description: "writer-created" }, WRITE_KEY);
    expect(created.res.status).toBe(201);
    expect((await call("PATCH", `/posts/${created.json.data.id}`, { description: "writer-updated" }, WRITE_KEY)).status).toBe(200);
    expect((await call("DELETE", `/posts/${created.json.data.id}`, undefined, WRITE_KEY)).status).toBe(204);
  });

  it("requires posts:write before validating publish input", async () => {
    const { json } = await createOne();

    expect((await call("POST", `/posts/${json.data.id}/publish`, {}, READ_KEY)).status).toBe(401);
    expect((await call("POST", `/posts/${json.data.id}/publish`, {}, UNRELATED_KEY)).status).toBe(401);
    expect((await call("POST", `/posts/${json.data.id}/publish`, {}, WRITE_KEY)).status).toBe(422);
  });

  it("is tenant-isolated: another workspace cannot read, patch, or delete (404)", async () => {
    const { json } = await createOne();
    expect((await call("GET", `/posts/${json.data.id}`, undefined, OTHER_KEY)).status).toBe(404);
    expect((await call("PATCH", `/posts/${json.data.id}`, { description: "x" }, OTHER_KEY)).status).toBe(404);
    expect((await call("DELETE", `/posts/${json.data.id}`, undefined, OTHER_KEY)).status).toBe(404);
    expect(await db.query.posts.findFirst({ where: eq(s.posts.id, json.data.id) })).toBeTruthy();
  });

  it("401 without auth", async () => {
    expect((await call("GET", "/posts", undefined, null)).status).toBe(401);
  });
});
