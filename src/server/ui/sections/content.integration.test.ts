import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, brands, content, posts, deliveries, rateLimitCounters } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// publishPost is covered elsewhere; mock it (no media/storage) but reflect the scheduled state onto
// the post so the swapped panel can be asserted. publishPosts / resolveBrand stay real.
vi.mock("@/lib/content/publish", () => ({ publishPost: vi.fn() }));
import { publishPost } from "@/lib/content/publish";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "content-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let htmx: Record<string, string> = {};
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../app");
  app = buildApp();
  await licenseInstance();

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(rateLimitCounters); // the register rate-limit is DB-backed + shared across files
  await db.delete(workspaces); // single-tenant test — clear leftover workspaces so register isn't multitenant-locked (pro lacks multi_workspace)
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = cookieFrom(res);
  htmx = { cookie, "HX-Request": "true", "content-type": "application/x-www-form-urlencoded" };
  const user = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true }, limit: 1 } },
  });
  workspaceId = user!.workspaceMembers[0].workspace_id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(content).where(eq(content.workspace_id, workspaceId));
  await db.delete(channels).where(eq(channels.workspace_id, workspaceId));
  await db.delete(brands).where(eq(brands.workspace_id, workspaceId));
  (publishPost as Mock).mockReset();
  (publishPost as Mock).mockImplementation(async ({ postId: pid, channelId: cid }: { postId: string; channelId: string }) => {
    const [d] = await db
      .insert(deliveries)
      .values({ workspace_id: workspaceId, channel_id: cid, format: "reel", status: "scheduled", payload: {}, scheduled_at: new Date(), run_at: new Date() })
      .returning();
    await db.update(posts).set({ delivery_id: d!.id, status: "scheduled" }).where(eq(posts.id, pid));
    return { delivery: d, post: {} };
  });
});

/** Brand 'tsa' with a mapped Instagram channel + content(profile=tsa) + one planned IG post. */
async function seedMapped() {
  await db.insert(brands).values({ workspace_id: workspaceId, key: "tsa", name: "Tech Skills Academy" });
  await db.insert(channels).values({ workspace_id: workspaceId, platform: "instagram", platform_id: "ig1", display_name: "@tsa", connection_mode: "manual_token", brand_key: "tsa", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w" });
  const [c] = await db.insert(content).values({ workspace_id: workspaceId, title: "Reel #8", content_type: "reel", status: "approved", profile: "tsa" }).returning();
  const [p] = await db.insert(posts).values({ workspace_id: workspaceId, content_id: c!.id, platform: "instagram", description: "weak llm caption", hashtags: "#a #b", cover_url: "https://cdn/cover.png", video_url: "https://cdn/x.mp4", status: "planned" }).returning();
  return { contentId: c!.id, postId: p!.id };
}

describe("content cockpit", () => {
  it("redirects to login without a session", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/content")).status).toBe(302);
  });

  it("lists content grouped by brand", async () => {
    if (!TEST_DB) return;
    await seedMapped();
    const out = await (await app.request("/content", { headers: { cookie } })).text();
    expect(out).toContain("Reel #8");
    expect(out).toContain("Tech Skills Academy");
  });

  it("detail renders a post card with copy + edit", async () => {
    if (!TEST_DB) return;
    const { contentId } = await seedMapped();
    const out = await (await app.request(`/content/${contentId}`, { headers: { cookie } })).text();
    expect(out).toContain("weak llm caption");
    expect(out).toContain("Copy caption");
    expect(out).toContain("data-copy=");
    expect(out).toContain("Instagram");
    expect(out).toContain("Edit");
  });

  it("edit fragment returns a textarea; saving patches the description", async () => {
    if (!TEST_DB) return;
    const { contentId, postId } = await seedMapped();
    const edit = await (await app.request(`/content/${contentId}/posts/${postId}/edit`, { headers: { cookie } })).text();
    expect(edit).toContain("<textarea");
    expect(edit).toContain("weak llm caption");

    const res = await app.request(`/content/${contentId}/posts/${postId}/description`, {
      method: "POST", headers: htmx, body: new URLSearchParams({ description: "polished caption" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("polished caption");
    expect((await db.query.posts.findFirst({ where: eq(posts.id, postId) }))!.description).toBe("polished caption");
  });

  it("shows the brand-resolved publish control (checkbox + target), not a channel picker", async () => {
    if (!TEST_DB) return;
    const { contentId } = await seedMapped();
    const out = await (await app.request(`/content/${contentId}`, { headers: { cookie } })).text();
    expect(out).toContain('name="postIds"');
    expect(out).toContain("@tsa");
    expect(out).toContain("Publish now");
    expect(out).toContain("psPublish(");
    expect(out).not.toContain('name="channelId"');
  });

  it("warns when the content has no brand (planned but unmapped)", async () => {
    if (!TEST_DB) return;
    const [c] = await db.insert(content).values({ workspace_id: workspaceId, title: "Orphan", status: "approved" }).returning();
    await db.insert(posts).values({ workspace_id: workspaceId, content_id: c!.id, platform: "instagram", status: "planned", video_url: "https://cdn/x.mp4" });
    const out = await (await app.request(`/content/${c!.id}`, { headers: { cookie } })).text();
    expect(out).toContain("Set in Brands");
    expect(out).not.toContain('name="postIds"');
  });

  it("per-row publish resolves the brand channel and shows the delivery link", async () => {
    if (!TEST_DB) return;
    const { contentId, postId } = await seedMapped();
    const res = await app.request(`/content/${contentId}/posts/${postId}/publish`, {
      method: "POST", headers: htmx, body: new URLSearchParams({ mode: "now" }),
    });
    expect(res.status).toBe(200);
    expect(publishPost).toHaveBeenCalledWith(expect.objectContaining({ postId, when: "now" }), workspaceId);
    expect(await res.text()).toContain("view delivery");
  });

  it("batch publish schedules all selected posts at a future time", async () => {
    if (!TEST_DB) return;
    const { contentId, postId } = await seedMapped();
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const res = await app.request(`/content/${contentId}/publish-batch`, {
      method: "POST", headers: htmx, body: new URLSearchParams({ postIds: postId, mode: "schedule", at: when }),
    });
    expect(res.status).toBe(200);
    expect(publishPost).toHaveBeenCalledWith(expect.objectContaining({ postId, when }), workspaceId);
    expect(await res.text()).toContain("view delivery");
  });

  it("an already-published post shows the link, not a publish control", async () => {
    if (!TEST_DB) return;
    await db.insert(brands).values({ workspace_id: workspaceId, key: "tsa", name: "TSA" });
    const [c] = await db.insert(content).values({ workspace_id: workspaceId, title: "live", profile: "tsa" }).returning();
    await db.insert(posts).values({ workspace_id: workspaceId, content_id: c!.id, platform: "instagram", status: "published", published_url: "https://www.instagram.com/reel/ABC/" });
    const out = await (await app.request(`/content/${c!.id}`, { headers: { cookie } })).text();
    expect(out).toContain("open ↗");
    expect(out).not.toContain('name="postIds"');
  });

  it("a non-http published_url (javascript:) renders as inert text, never an href", async () => {
    if (!TEST_DB) return;
    const [c] = await db.insert(content).values({ workspace_id: workspaceId, title: "xss" }).returning();
    await db.insert(posts).values({ workspace_id: workspaceId, content_id: c!.id, platform: "instagram", status: "published", published_url: "javascript:fetch('/api-keys')" });
    const out = await (await app.request(`/content/${c!.id}`, { headers: { cookie } })).text();
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain("<code");
  });
});
