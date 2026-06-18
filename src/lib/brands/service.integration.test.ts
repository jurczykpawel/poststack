import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let seedWorkspace: typeof import("../../../tests/helpers/workspace").seedWorkspace;
let svc: typeof import("./service");
let resolve: typeof import("./resolve");
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
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ seedWorkspace } = await import("../../../tests/helpers/workspace"));
  svc = await import("./service");
  resolve = await import("./resolve");
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  await db.$client.end();
});

beforeEach(async () => {
  if (!TEST_DB) return;
  if (WS) {
    await db.delete(schema.channels).where(eq(schema.channels.workspace_id, WS));
    await db.delete(schema.brands).where(eq(schema.brands.workspace_id, WS));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS));
  }
  WS = await seedWorkspace(db, schema, { slug: `brand-${Math.random().toString(36).slice(2)}` });
});

async function makeChannel(input: {
  platform: string;
  platformId: string;
  displayName?: string;
  brandKey?: string | null;
  status?: "active" | "disabled" | "needs_reauth";
}): Promise<string> {
  const [row] = await db
    .insert(schema.channels)
    .values({
      workspace_id: WS,
      platform: input.platform as (typeof schema.channels.$inferInsert)["platform"],
      platform_id: input.platformId,
      display_name: input.displayName ?? null,
      connection_mode: "oauth",
      status: input.status ?? "active",
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "wh",
      brand_key: input.brandKey ?? null,
    })
    .returning({ id: schema.channels.id });
  return row!.id;
}

describe("brand service (workspace-scoped)", () => {
  it("creates, lists, gets, updates a brand", async () => {
    if (!TEST_DB) return;
    const b = await svc.createBrand({ key: "techskills.academy", name: "Tech Skills Academy", accent: "#7aa2f7" }, WS);
    expect(b.key).toBe("techskills.academy");
    await svc.createBrand({ key: "wir", name: "Wsparcie i Rozwój" }, WS);
    const all = await svc.listBrands(WS);
    expect(all.map((x) => x.key).sort()).toEqual(["techskills.academy", "wir"]);
    expect((await svc.getBrand(WS, "techskills.academy"))!.accent).toBe("#7aa2f7");
    const updated = await svc.updateBrand(WS, "techskills.academy", { name: "TSA", icon: "🟦" });
    expect(updated.name).toBe("TSA");
    expect(updated.icon).toBe("🟦");
  });

  it("rejects a duplicate brand key with 409, unknown update with 404", async () => {
    if (!TEST_DB) return;
    await svc.createBrand({ key: "tsa", name: "TSA" }, WS);
    await expect(svc.createBrand({ key: "tsa", name: "again" }, WS)).rejects.toMatchObject({ status: 409 });
    await expect(svc.updateBrand(WS, "nope", { name: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("persists a valid auto-Story template and rejects an unknown one (400)", async () => {
    if (!TEST_DB) return;
    const b = await svc.createBrand({ key: "tsa", name: "TSA", story_template: "phone" }, WS);
    expect(b.story_template).toBe("phone");
    const u = await svc.updateBrand(WS, "tsa", { story_template: "fullbleed" });
    expect(u.story_template).toBe("fullbleed");
    const cleared = await svc.updateBrand(WS, "tsa", { story_template: null });
    expect(cleared.story_template).toBeNull();
    await expect(svc.createBrand({ key: "x", name: "X", story_template: "bogus" }, WS)).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateBrand(WS, "tsa", { story_template: "nope" })).rejects.toMatchObject({ status: 400 });
  });

  it("the same brand key is allowed in a DIFFERENT workspace (per-workspace uniqueness)", async () => {
    if (!TEST_DB) return;
    await svc.createBrand({ key: "tsa", name: "TSA" }, WS);
    const WS2 = await seedWorkspace(db, schema, { slug: `brand2-${Math.random().toString(36).slice(2)}` });
    await expect(svc.createBrand({ key: "tsa", name: "TSA elsewhere" }, WS2)).resolves.toMatchObject({ key: "tsa" });
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, WS2));
  });

  it("deleting a brand unassigns its channels (FK set null), not deletes them", async () => {
    if (!TEST_DB) return;
    await svc.createBrand({ key: "tsa", name: "TSA" }, WS);
    const ch = await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa" });
    await svc.deleteBrand(WS, "tsa");
    expect(await svc.getBrand(WS, "tsa")).toBeUndefined();
    const row = await db.query.channels.findFirst({ where: eq(schema.channels.id, ch) });
    expect(row).toBeDefined();
    expect(row!.brand_key).toBeNull();
  });

  it("assignChannelBrand sets and clears, rejecting unknown brand/channel", async () => {
    if (!TEST_DB) return;
    await svc.createBrand({ key: "tsa", name: "TSA" }, WS);
    const ch = await makeChannel({ platform: "youtube", platformId: "UC1" });
    await svc.assignChannelBrand(WS, ch, "tsa");
    expect((await db.query.channels.findFirst({ where: eq(schema.channels.id, ch) }))!.brand_key).toBe("tsa");
    await svc.assignChannelBrand(WS, ch, null);
    expect((await db.query.channels.findFirst({ where: eq(schema.channels.id, ch) }))!.brand_key).toBeNull();
    await expect(svc.assignChannelBrand(WS, ch, "ghost")).rejects.toMatchObject({ status: 400 });
    await expect(svc.assignChannelBrand(WS, "00000000-0000-0000-0000-000000000000", "tsa")).rejects.toMatchObject({ status: 404 });
  });
});

describe("brand → channel resolution (workspace-scoped)", () => {
  beforeEach(async () => {
    if (!TEST_DB) return;
    // BRANDLIMIT1 routes resolution through the license check (free = 1-brand limit). The license is a
    // global singleton (instance_license) + an in-memory cache — a prior file may have left a row/tier;
    // clear both so these tests see the default free tier deterministically.
    const gate = await import("@/lib/license/gate");
    await db.delete(schema.instanceLicense);
    gate.invalidateLicenseCache();
    await svc.createBrand({ key: "tsa", name: "TSA" }, WS);
  });

  it("resolves IG vs FB by distinct platform, and exact-platform for others", async () => {
    if (!TEST_DB) return;
    const ig = await makeChannel({ platform: "instagram", platformId: "ig1", brandKey: "tsa", displayName: "TSA IG" });
    const fb = await makeChannel({ platform: "facebook", platformId: "pg1", brandKey: "tsa", displayName: "TSA Page" });
    const yt = await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa", displayName: "TSA YT" });
    expect((await resolve.resolveChannelForBrandPlatform(WS, "tsa", "instagram"))!.id).toBe(ig);
    expect((await resolve.resolveChannelForBrandPlatform(WS, "tsa", "facebook"))!.id).toBe(fb);
    expect((await resolve.resolveChannelForBrandPlatform(WS, "tsa", "youtube"))!.id).toBe(yt);
    expect((await resolve.resolveChannelForBrandPlatform(WS, "tsa", "youtube"))!.label).toBe("TSA YT");
  });

  it("returns null when there is no channel for the platform", async () => {
    if (!TEST_DB) return;
    await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa" });
    expect(await resolve.resolveChannelForBrandPlatform(WS, "tsa", "tiktok")).toBeNull();
  });

  it("returns null (never guesses) when the slot is ambiguous", async () => {
    if (!TEST_DB) return;
    await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa" });
    await makeChannel({ platform: "youtube", platformId: "UC2", brandKey: "tsa" });
    expect(await resolve.resolveChannelForBrandPlatform(WS, "tsa", "youtube")).toBeNull();
  });

  it("ignores disabled and other brands' channels", async () => {
    if (!TEST_DB) return;
    await svc.createBrand({ key: "wir", name: "WiR" }, WS);
    await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa", status: "disabled" });
    await makeChannel({ platform: "youtube", platformId: "UC2", brandKey: "wir" });
    expect(await resolve.resolveChannelForBrandPlatform(WS, "tsa", "youtube")).toBeNull();
  });

  it("BRANDLIMIT1: on free tier a brand beyond the limit never resolves a channel (locked)", async () => {
    if (!TEST_DB) return;
    // `tsa` already exists (oldest). A second brand is beyond free's 1-brand limit → locked → no publish.
    await svc.createBrand({ key: "wir", name: "WiR" }, WS);
    await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa", displayName: "TSA YT" });
    await makeChannel({ platform: "youtube", platformId: "UC2", brandKey: "wir", displayName: "WiR YT" });
    // Oldest brand still resolves; the locked one is gated to null even though its channel is unambiguous.
    expect((await resolve.resolveChannelForBrandPlatform(WS, "tsa", "youtube"))!.label).toBe("TSA YT");
    expect(await resolve.resolveChannelForBrandPlatform(WS, "wir", "youtube")).toBeNull();
  });

  it("resolveBrandSlots reports channel / null / ambiguous per platform", async () => {
    if (!TEST_DB) return;
    await makeChannel({ platform: "youtube", platformId: "UC1", brandKey: "tsa", displayName: "TSA YT" });
    await makeChannel({ platform: "tiktok", platformId: "tt1", brandKey: "tsa" });
    await makeChannel({ platform: "tiktok", platformId: "tt2", brandKey: "tsa" });
    const slots = await resolve.resolveBrandSlots(WS, "tsa");
    const yt = slots.find((s) => s.platform === "youtube")!;
    const tt = slots.find((s) => s.platform === "tiktok")!;
    const ig = slots.find((s) => s.platform === "instagram")!;
    expect(yt.channel!.label).toBe("TSA YT");
    expect(tt.ambiguous).toBe(true);
    expect(tt.channel).toBeNull();
    expect(ig.channel).toBeNull();
    expect(ig.ambiguous).toBe(false);
  });
});
