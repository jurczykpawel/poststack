import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

const TEST_DB = process.env.TEST_DATABASE_URL;
const KEY = "sk_live_brands_key_abcd00000000001";
const OTHER_KEY = "sk_live_brands_other_abcd0000000002";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: Hono;

const WS = "c0ffee06-0000-4000-8000-000000000b01";
const OTHER_WS = "c0ffee06-0000-4000-8000-000000000b02";

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
  for (const ws of [WS, OTHER_WS]) await db.delete(s.workspaces).where(eq(s.workspaces.id, ws));
  await db.insert(s.workspaces).values([
    { id: WS, name: "W", slug: `w-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  const hash = (k: string) => createHash("sha256").update(k).digest("hex");
  await db.insert(s.apiKeys).values([
    { workspace_id: WS, name: "k", key_hash: hash(KEY), key_prefix: "sk_live_br" },
    { workspace_id: OTHER_WS, name: "o", key_hash: hash(OTHER_KEY), key_prefix: "sk_live_bo" },
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

describe.skipIf(!TEST_DB)("/api/v1/brands", () => {
  it("creates a brand and lists it (workspace-scoped)", async () => {
    const res = await call("POST", "/brands", { key: "acme", name: "Acme", accent: "#ff0000" });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({ key: "acme", name: "Acme" });

    await call("POST", "/brands", { key: "acme", name: "Other WS Acme" }, OTHER_KEY); // same key, other tenant
    const list = await call("GET", "/brands");
    const listed = await list.json();
    expect(Array.isArray(listed.data)).toBe(true);
    expect(listed.data.map((b: { key: string }) => b.key)).toEqual(["acme"]); // only this workspace's
  });

  it("rejects a brand with no key/name (422)", async () => {
    expect((await call("POST", "/brands", {})).status).toBe(422);
  });

  it("409 on a duplicate brand key in the same workspace", async () => {
    await call("POST", "/brands", { key: "dup", name: "First" });
    expect((await call("POST", "/brands", { key: "dup", name: "Second" })).status).toBe(409);
  });

  it("PATCH updates a brand", async () => {
    await call("POST", "/brands", { key: "edit", name: "Before" });
    const res = await call("PATCH", "/brands/edit", { name: "After", accent: "#00ff00" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ name: "After", accent: "#00ff00" });
  });

  it("PATCH/DELETE on an unknown brand is 404", async () => {
    expect((await call("PATCH", "/brands/nope", { name: "x" })).status).toBe(404);
    expect((await call("DELETE", "/brands/nope")).status).toBe(404);
  });

  it("DELETE removes the brand", async () => {
    await call("POST", "/brands", { key: "gone", name: "Gone" });
    expect((await call("DELETE", "/brands/gone")).status).toBe(204);
    const list = await (await call("GET", "/brands")).json();
    expect(list.data.map((b: { key: string }) => b.key)).not.toContain("gone");
  });

  it("is tenant-isolated: another workspace cannot patch or delete the brand (404)", async () => {
    await call("POST", "/brands", { key: "mine", name: "Mine" });
    expect((await call("PATCH", "/brands/mine", { name: "x" }, OTHER_KEY)).status).toBe(404);
    expect((await call("DELETE", "/brands/mine", undefined, OTHER_KEY)).status).toBe(404);
    expect(await db.query.brands.findFirst({ where: eq(s.brands.key, "mine") })).toBeTruthy();
  });

  it("401 without auth", async () => {
    expect((await call("GET", "/brands", undefined, null)).status).toBe(401);
  });

  // AIDISC2: the brand is the level that matters most in practice — one piece of material goes out to
  // every channel of a brand — so its default has to be settable over the API, not only in SQL.
  it("stores and updates the brand's default AI declaration, and can clear it back to nothing", async () => {
    const created = await call("POST", "/brands", {
      key: "aibrand",
      name: "AI Brand",
      default_ai_disclosure: "ai_generated",
      default_ai_disclosure_note: "Made with AI.",
    });
    expect(created.status).toBe(201);
    expect((await created.json()).data).toMatchObject({
      defaultAiDisclosure: "ai_generated",
      defaultAiDisclosureNote: "Made with AI.",
    });

    const patched = await call("PATCH", "/brands/aibrand", { default_ai_disclosure: "ai_assisted" });
    expect((await patched.json()).data).toMatchObject({
      defaultAiDisclosure: "ai_assisted",
      defaultAiDisclosureNote: "Made with AI.", // untouched by a patch that doesn't mention it
    });

    // Explicit null switches a brand-wide declaration off without deleting the brand.
    const cleared = await call("PATCH", "/brands/aibrand", { default_ai_disclosure: null });
    expect((await cleared.json()).data).toMatchObject({ defaultAiDisclosure: null });
  });

  it("defaults to no declaration when a brand is created without one", async () => {
    const res = await call("POST", "/brands", { key: "plain", name: "Plain" });
    expect((await res.json()).data).toMatchObject({ defaultAiDisclosure: null, defaultAiDisclosureNote: null });
  });

  it("rejects an AI level that isn't one of the three", async () => {
    const res = await call("POST", "/brands", { key: "bad", name: "Bad", default_ai_disclosure: "mostly" });
    expect(res.status).toBe(422);
  });
});

// BRANDCH1: brand → channel resolution over the API. The `/content-pipeline` skill already documents
// this endpoint (script → post → publish needs "which channel does brand X publish YouTube to"), so
// the shape here must stay exactly `{ platform, channel: { id, label } | null, ambiguous }`.
describe.skipIf(!TEST_DB)("GET /api/v1/brands/:brandKey/channels", () => {
  type ChannelInsert = (typeof import("@/db/schema"))["channels"]["$inferInsert"];
  const chan = (id: string, platform: ChannelInsert["platform"], extra: Partial<ChannelInsert> = {}): ChannelInsert => ({
    id,
    workspace_id: WS,
    platform,
    platform_id: `${String(platform)}-${id.slice(-4)}`,
    token_encrypted: "x",
    webhook_secret: "s",
    ...extra,
  });

  it("resolves the mapped channel per editorial platform", async () => {
    await call("POST", "/brands", { key: "acme", name: "Acme" });
    await db.insert(s.channels).values([
      chan("c0ffee06-0000-4000-8000-0000000000c1", "youtube", { brand_key: "acme", display_name: "Acme TV" }),
      // Unmapped channel on another platform — must NOT resolve into the brand's slots.
      chan("c0ffee06-0000-4000-8000-0000000000c2", "instagram"),
    ]);

    const res = await call("GET", "/brands/acme/channels");
    expect(res.status).toBe(200);
    const slots = (await res.json()).data as Array<{ platform: string; channel: { id: string; label: string } | null; ambiguous: boolean }>;

    const yt = slots.find((s) => s.platform === "youtube");
    expect(yt).toMatchObject({ channel: { id: "c0ffee06-0000-4000-8000-0000000000c1", label: "Acme TV" }, ambiguous: false });
    expect(slots.find((s) => s.platform === "instagram")).toMatchObject({ channel: null, ambiguous: false });
    // Every editorial platform gets a slot, so a caller can tell "unmapped" from "unsupported".
    expect(slots.map((s) => s.platform)).toEqual(
      expect.arrayContaining(["instagram", "facebook", "tiktok", "youtube", "threads", "x", "linkedin"]),
    );
  });

  it("flags ambiguity instead of guessing when a brand has two channels on one platform", async () => {
    await call("POST", "/brands", { key: "dual", name: "Dual" });
    await db.insert(s.channels).values([
      chan("c0ffee06-0000-4000-8000-0000000000d1", "youtube", { brand_key: "dual", display_name: "One" }),
      chan("c0ffee06-0000-4000-8000-0000000000d2", "youtube", { brand_key: "dual", display_name: "Two" }),
    ]);

    const slots = (await (await call("GET", "/brands/dual/channels")).json()).data as Array<{ platform: string; channel: unknown; ambiguous: boolean }>;
    expect(slots.find((s) => s.platform === "youtube")).toMatchObject({ channel: null, ambiguous: true });
  });

  it("404s for an unregistered brand (so a caller stops instead of publishing blind)", async () => {
    expect((await call("GET", "/brands/nope/channels")).status).toBe(404);
  });

  it("is tenant-isolated and requires auth", async () => {
    await call("POST", "/brands", { key: "mine2", name: "Mine" });
    expect((await call("GET", "/brands/mine2/channels", undefined, OTHER_KEY)).status).toBe(404);
    expect((await call("GET", "/brands/mine2/channels", undefined, null)).status).toBe(401);
  });
});
