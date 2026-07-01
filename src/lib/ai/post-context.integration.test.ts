import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// ADCTX2: mock the network boundary (the live Graph fallback) — the DB stays real.
const provider = { getPostText: vi.fn(async (_t: unknown, postId: string) => `live caption for ${postId}`) };
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let resolveLocalPostCaption: typeof import("./post-context").resolveLocalPostCaption;
let resolvePostContext: typeof import("./post-context").resolvePostContext;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;

const WS = "c0ffee06-0000-4000-8000-000000000c01";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  ({ resolveLocalPostCaption, resolvePostContext } = await import("./post-context"));
  ({ encryptTokens } = await import("@/lib/crypto"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  provider.getPostText.mockClear();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await seedWorkspace(db, s, { id: WS, slug: `ctx-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end();
});

async function seedPost(opts: { platformPostId: string; description?: string | null; hashtags?: string | null; title?: string }) {
  const [c] = await db.insert(s.content).values({ workspace_id: WS, title: opts.title ?? "Editorial title" }).returning({ id: s.content.id });
  await db.insert(s.posts).values({
    workspace_id: WS,
    content_id: c!.id,
    platform: "facebook",
    platform_post_id: opts.platformPostId,
    description: opts.description ?? null,
    hashtags: opts.hashtags ?? null,
  });
}

async function seedChannel(): Promise<string> {
  const [ch] = await db
    .insert(s.channels)
    .values({ workspace_id: WS, platform: "facebook", platform_id: "PG-CTX", token_encrypted: encryptTokens({ access_token: "tok" }), webhook_secret: "w", status: "active" })
    .returning({ id: s.channels.id });
  return ch!.id;
}

describe.skipIf(!TEST_DB)("resolvePostContext (ADCTX2 — local join, then live Graph fallback)", () => {
  it("returns the local caption without ever calling the live provider", async () => {
    await seedPost({ platformPostId: "pfbid-local", description: "Local caption" });
    const chId = await seedChannel();
    expect(await resolvePostContext(WS, chId, "pfbid-local")).toBe("Local caption");
    expect(provider.getPostText).not.toHaveBeenCalled();
  });

  it("falls back to the live Graph API when no local post record exists", async () => {
    const chId = await seedChannel();
    expect(await resolvePostContext(WS, chId, "pfbid-external")).toBe("live caption for pfbid-external");
    expect(provider.getPostText).toHaveBeenCalledTimes(1);
  });

  it("is best-effort: a failed live fetch resolves to undefined, never throws", async () => {
    provider.getPostText.mockRejectedValueOnce(new Error("Meta 500"));
    const chId = await seedChannel();
    await expect(resolvePostContext(WS, chId, "pfbid-fails")).resolves.toBeUndefined();
  });

  it("returns undefined immediately when platformPostId is undefined — no DB or network calls", async () => {
    const chId = await seedChannel();
    expect(await resolvePostContext(WS, chId, undefined)).toBeUndefined();
    expect(provider.getPostText).not.toHaveBeenCalled();
  });

  it("returns undefined when the channel does not exist (defensive — should not happen in practice)", async () => {
    expect(await resolvePostContext(WS, "00000000-0000-4000-8000-000000000000", "pfbid-x")).toBeUndefined();
  });
});

describe.skipIf(!TEST_DB)("resolveLocalPostCaption", () => {
  it("returns the built caption (description + hashtags) for a locally-published post", async () => {
    await seedPost({ platformPostId: "pfbid-1", description: "New comic issue #47 is out!", hashtags: "#comics #indie" });
    const caption = await resolveLocalPostCaption(WS, "pfbid-1");
    expect(caption).toBe("New comic issue #47 is out!\n\n#comics #indie");
  });

  it("falls back to content.title when the post has no description/hashtags", async () => {
    await seedPost({ platformPostId: "pfbid-2", description: null, hashtags: null, title: "Issue 47 announcement" });
    const caption = await resolveLocalPostCaption(WS, "pfbid-2");
    expect(caption).toBe("Issue 47 announcement");
  });

  it("returns undefined when no local post matches (published outside PostStack)", async () => {
    expect(await resolveLocalPostCaption(WS, "not-a-known-post-id")).toBeUndefined();
  });

  it("returns undefined when platformPostId is undefined (no post linkage at all, e.g. a DM)", async () => {
    expect(await resolveLocalPostCaption(WS, undefined)).toBeUndefined();
  });

  it("is workspace-scoped: a post with the same platform_post_id in another workspace never matches", async () => {
    const OTHER = "c0ffee06-0000-4000-8000-000000000c02";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER));
    await seedWorkspace(db, s, { id: OTHER, slug: `ctx-other-${OTHER}` });
    const [c] = await db.insert(s.content).values({ workspace_id: OTHER, title: "Other WS title" }).returning({ id: s.content.id });
    await db.insert(s.posts).values({ workspace_id: OTHER, content_id: c!.id, platform: "facebook", platform_post_id: "shared-id", description: "Other workspace's caption" });
    expect(await resolveLocalPostCaption(WS, "shared-id")).toBeUndefined();
    await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER));
  });
});
