import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let svc: typeof import("./service");
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
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  svc = await import("./service");
  WS = await seedWorkspace(db, schema, { slug: `content-${Date.now()}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
});

describe("content service (workspace-scoped)", () => {
  it("creates and fetches a content item", async () => {
    if (!TEST_DB) return;
    const c = await svc.createContent({ title: "Reel #8", contentType: "reel", profile: "TSA", status: "approved" }, WS);
    expect(c.workspace_id).toBe(WS);
    const got = await svc.getContent(c.id, WS);
    expect(got!.title).toBe("Reel #8");
    expect(got!.posts).toEqual([]);
  });

  it("lists newest-first with cursor pagination", async () => {
    if (!TEST_DB) return;
    for (const t of ["a", "b", "c"]) await svc.createContent({ title: t }, WS);
    const p1 = await svc.listContent({ workspaceId: WS, limit: 2 });
    expect(p1.items.length).toBe(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await svc.listContent({ workspaceId: WS, limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.length).toBe(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(3);
  });

  it("filters by status/profile/contentType and q (title ILIKE)", async () => {
    if (!TEST_DB) return;
    await svc.createContent({ title: "AI terminal", status: "approved", profile: "TSA", contentType: "reel" }, WS);
    await svc.createContent({ title: "Other", status: "draft", profile: "WiR", contentType: "post" }, WS);
    expect((await svc.listContent({ workspaceId: WS, limit: 10, status: "approved" })).items.length).toBe(1);
    expect((await svc.listContent({ workspaceId: WS, limit: 10, profile: "WiR" })).items.length).toBe(1);
    expect((await svc.listContent({ workspaceId: WS, limit: 10, contentType: "reel" })).items.length).toBe(1);
    expect((await svc.listContent({ workspaceId: WS, limit: 10, q: "termi" })).items[0]!.title).toBe("AI terminal");
  });

  it("sorts by created_at ascending when asked", async () => {
    if (!TEST_DB) return;
    const first = await svc.createContent({ title: "first" }, WS);
    await new Promise((r) => setTimeout(r, 5));
    await svc.createContent({ title: "second" }, WS);
    const asc = await svc.listContent({ workspaceId: WS, limit: 10, sort: "created_at" });
    expect(asc.items[0]!.id).toBe(first.id);
  });

  it("rejects an invalid sort field with 422", async () => {
    if (!TEST_DB) return;
    await expect(svc.listContent({ workspaceId: WS, limit: 10, sort: "bogus" })).rejects.toThrowError(/sort/i);
  });

  it("is idempotent on an Idempotency-Key (same key returns the first row, per workspace)", async () => {
    if (!TEST_DB) return;
    const a = await svc.createContent({ title: "first" }, WS, "key-123");
    const b = await svc.createContent({ title: "second" }, WS, "key-123");
    expect(b.id).toBe(a.id);
    expect(b.title).toBe("first");
    expect((await svc.listContent({ workspaceId: WS, limit: 10 })).items.length).toBe(1);
  });

  it("the same Idempotency-Key in a DIFFERENT workspace creates a separate row", async () => {
    if (!TEST_DB) return;
    const a = await svc.createContent({ title: "first" }, WS, "dup-key");
    const WS2 = await seedWorkspace(db, schema, { slug: `content2-${Date.now()}` });
    const b = await svc.createContent({ title: "other ws" }, WS2, "dup-key");
    expect(b.id).not.toBe(a.id);
    await db.delete(schema.content).where(eq(schema.content.workspace_id, WS2));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });

  it("patches and deletes a content item; linked posts survive with null content_id", async () => {
    if (!TEST_DB) return;
    const c = await svc.createContent({ title: "del-me" }, WS);
    const p = await svc.createPost({ contentId: c.id, platform: "instagram", description: "hi" }, WS);
    await svc.patchContent(c.id, WS, { status: "archived" });
    expect((await svc.getContent(c.id, WS))!.status).toBe("archived");
    expect(await svc.deleteContent(c.id, WS)).toBe(true);
    expect(await svc.getContent(c.id, WS)).toBeUndefined();
    const orphan = await svc.getPost(p.id, WS);
    expect(orphan!.content_id).toBeNull();
  });
});

describe("editorial posts service (workspace-scoped)", () => {
  it("creates a post, lists by contentId/platform/status, patches, deletes", async () => {
    if (!TEST_DB) return;
    const c = await svc.createContent({ title: "parent" }, WS);
    const p = await svc.createPost({ contentId: c.id, platform: "tiktok", description: "draft caption", status: "planned" }, WS);
    expect((await svc.listPosts({ workspaceId: WS, limit: 10, contentId: c.id })).items.length).toBe(1);
    expect((await svc.listPosts({ workspaceId: WS, limit: 10, platform: "tiktok" })).items.length).toBe(1);
    expect((await svc.listPosts({ workspaceId: WS, limit: 10, status: "planned" })).items.length).toBe(1);
    await svc.patchPost(p.id, WS, { description: "polished caption" });
    expect((await svc.getPost(p.id, WS))!.description).toBe("polished caption");
    expect(await svc.deletePost(p.id, WS)).toBe(true);
    expect(await svc.getPost(p.id, WS)).toBeUndefined();
  });

  it("UNIFY P2.2: accepts + persists an auto_reply config on a post (camelCase round-trip)", async () => {
    if (!TEST_DB) return;
    const p = await svc.createPost(
      { platform: "instagram", description: "reel", autoReply: { keywords: [{ value: "link", matchType: "contains" }], responseType: "text", dmText: "DM!", replyMode: "dm" } },
      WS,
    );
    const got = await svc.getPost(p.id, WS);
    const ar = got!.auto_reply as { dmText?: string; keywords?: { value: string }[] };
    expect(ar.dmText).toBe("DM!");
    expect(ar.keywords).toEqual([{ value: "link", matchType: "contains" }]);
  });

  it("filters posts by q (description ILIKE)", async () => {
    if (!TEST_DB) return;
    await svc.createPost({ platform: "x", description: "hello world" }, WS);
    await svc.createPost({ platform: "x", description: "nothing here" }, WS);
    const r = await svc.listPosts({ workspaceId: WS, limit: 10, q: "hello" });
    expect(r.items.length).toBe(1);
    expect(r.items[0]!.description).toContain("hello");
  });
});
