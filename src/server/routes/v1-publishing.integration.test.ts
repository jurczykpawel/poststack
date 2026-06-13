import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

// End-to-end smoke for the publishing /api/v1 surface (Phase 1 DoD): create content → create post →
// publish → a scheduled delivery is created and linked, all via the REST API authenticated with an
// API key, workspace-scoped. Also proves cross-workspace isolation + unauthenticated rejection.
const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let app: Hono;
let WS = "";
let CH = "";
const RAW_KEY = "sk_live_publishing_smoke_key_0123456789ab";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  const { seedWorkspace } = await import("../../../tests/helpers/workspace");
  const { encryptTokens } = await import("@/lib/crypto");
  const { buildApp } = await import("../app");
  app = buildApp();
  WS = await seedWorkspace(db, schema, { slug: `v1pub-${Date.now()}` });
  await db.insert(schema.apiKeys).values({
    workspace_id: WS,
    name: "smoke",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: RAW_KEY.slice(0, 16),
  });
  const [c] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: "tiktok",
      platform_id: "ACCT-SMOKE",
      connection_mode: "manual_token",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
    })
    .returning({ id: schema.channels.id });
  CH = c!.id;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.posts).where(eq(schema.posts.workspace_id, WS));
  await db.delete(schema.deliveries).where(eq(schema.deliveries.workspace_id, WS));
  await db.delete(schema.content).where(eq(schema.content.workspace_id, WS));
  await db.delete(schema.media).where(eq(schema.media.workspace_id, WS));
});
afterEach(() => vi.unstubAllGlobals());

const auth = { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  app.request(`/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body) });

describe("publishing /api/v1 (e2e smoke)", () => {
  it("rejects an unauthenticated request", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/content", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("content → post → publish creates a linked scheduled delivery (camelCase envelope)", async () => {
    if (!TEST_DB) return;
    // stub the media fetch with a real mp4 magic-byte body so the probe accepts it (publish registers
    // the post's video URL into storage). example.com resolves to a public IP → passes the SSRF guard.
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(mp4, { status: 200, headers: { "content-type": "video/mp4" } })));

    const cRes = await post("/content", { title: "Smoke reel", contentType: "video" });
    expect(cRes.status).toBe(201);
    const cBody = await cRes.json();
    expect(cBody.data.id).toBeTruthy();
    expect(cBody.data.createdAt).toBeTruthy(); // camelCase envelope

    const pRes = await post("/posts", { contentId: cBody.data.id, platform: "tiktok", videoUrl: "https://example.com/x.mp4", description: "hello" });
    expect(pRes.status).toBe(201);
    const postId = (await pRes.json()).data.id;

    const pubRes = await post(`/posts/${postId}/publish`, { channelId: CH, when: "now" });
    expect(pubRes.status).toBe(200);
    const pub = await pubRes.json();
    expect(pub.data.delivery.status).toBe("scheduled");
    expect(pub.data.post.deliveryId).toBe(pub.data.delivery.id);

    // the delivery row really exists and is workspace-scoped
    const d = await db.query.deliveries.findFirst({ where: eq(schema.deliveries.id, pub.data.delivery.id) });
    expect(d!.workspace_id).toBe(WS);
    expect(d!.channel_id).toBe(CH);
  });

  it("a publish to another workspace's channel is rejected (tenancy)", async () => {
    if (!TEST_DB) return;
    const { seedWorkspace } = await import("../../../tests/helpers/workspace");
    const { encryptTokens } = await import("@/lib/crypto");
    const WS2 = await seedWorkspace(db, schema, { slug: `v1pub2-${Date.now()}` });
    const [otherCh] = await db.insert(schema.channels).values({
      workspace_id: WS2, platform: "tiktok", platform_id: "OTHER", connection_mode: "manual_token",
      status: "active", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "wh",
    }).returning({ id: schema.channels.id });

    const cRes = await post("/content", { title: "x", contentType: "video" });
    const pRes = await post("/posts", { contentId: (await cRes.json()).data.id, platform: "tiktok", videoUrl: "https://example.com/x.mp4" });
    const postId = (await pRes.json()).data.id;
    // WS's key publishing to WS2's channel → 404 (channel not found in this workspace)
    const pubRes = await post(`/posts/${postId}/publish`, { channelId: otherCh!.id, when: "now" });
    expect(pubRes.status).toBe(404);
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });
});
