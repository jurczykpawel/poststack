import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, brands } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "brands-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let createBrandSvc: typeof import("@/lib/brands/service").createBrand;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/session=[^;]+/);
  return m ? m[0] : "";
}
const form = (body: Record<string, string>) => ({
  method: "POST" as const,
  headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body),
});

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
  ({ createBrand: createBrandSvc } = await import("@/lib/brands/service"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../../app");
  app = buildApp();
  await licenseInstance(); // pro → multi_brand unlocked (tests create several brands)

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  await db.delete(users).where(eq(users.email, EMAIL));
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  cookie = cookieFrom(res);
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
  await db.delete(channels).where(eq(channels.workspace_id, workspaceId));
  await db.delete(brands).where(eq(brands.workspace_id, workspaceId));
});

async function makeChannel(platform: string, accountId: string, subKind?: string): Promise<string> {
  const [row] = await db
    .insert(channels)
    .values({
      workspace_id: workspaceId,
      platform: platform as (typeof channels.$inferInsert)["platform"],
      platform_id: accountId,
      token_encrypted: encryptTokens({ access_token: "T" }),
      webhook_secret: "w",
      metadata: subKind ? { subKind } : {},
    })
    .returning({ id: channels.id });
  return row!.id;
}

describe("Brands section", () => {
  it("renders the page with the New brand form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/brands", { headers: { cookie } });
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain("New brand");
    expect(out).toContain("No brands yet");
    expect(out).toContain('type="color"');
    expect(out).toContain("emoji-pick");
    expect(out).toContain("📮");
    expect(out).toContain("picks: ['📮'");
    expect(out).not.toContain('picks: ["');
  });

  it("creates a brand via the form, then lists it (CSS-safe ids for dotted keys)", async () => {
    if (!TEST_DB) return;
    const created = await app.request("/brands", form({ key: "techskills.academy", name: "Tech Skills Academy" }));
    expect(created.status).toBe(303);
    const page = await (await app.request("/brands", { headers: { cookie } })).text();
    expect(page).toContain("Tech Skills Academy");
    expect(page).toContain("techskills.academy");
    expect(page).toContain('id="brand-techskills-academy"');
    expect(page).toContain('hx-target="#brand-techskills-academy"');
    expect(page).toContain('id="slot-techskills-academy-instagram"');
    expect(page).not.toContain("brand-techskills.academy");
    expect(page).not.toContain("slot-techskills.academy");
  });

  it("assigns a channel to a brand+platform slot via PUT", async () => {
    if (!TEST_DB) return;
    await createBrandSvc({ key: "tsa", name: "TSA" }, workspaceId);
    const yt = await makeChannel("youtube", "UC1");
    const res = await app.request("/brands/tsa/slot/youtube", {
      method: "PUT", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channelId: yt }),
    });
    expect(res.status).toBe(200);
    expect((await db.query.channels.findFirst({ where: eq(channels.id, yt) }))!.brand_key).toBe("tsa");
  });

  it("assigning a new channel to a slot clears the previous one (one per slot)", async () => {
    if (!TEST_DB) return;
    await createBrandSvc({ key: "tsa", name: "TSA" }, workspaceId);
    const yt1 = await makeChannel("youtube", "UC1");
    const yt2 = await makeChannel("youtube", "UC2");
    await app.request("/brands/tsa/slot/youtube", { method: "PUT", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ channelId: yt1 }) });
    await app.request("/brands/tsa/slot/youtube", { method: "PUT", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ channelId: yt2 }) });
    expect((await db.query.channels.findFirst({ where: eq(channels.id, yt1) }))!.brand_key).toBeNull();
    expect((await db.query.channels.findFirst({ where: eq(channels.id, yt2) }))!.brand_key).toBe("tsa");
  });

  it("deletes a brand (channels become unassigned)", async () => {
    if (!TEST_DB) return;
    await createBrandSvc({ key: "tsa", name: "TSA" }, workspaceId);
    const yt = await makeChannel("youtube", "UC1");
    await db.update(channels).set({ brand_key: "tsa" }).where(eq(channels.id, yt));
    const res = await app.request("/brands/tsa/delete", form({}));
    expect(res.status).toBe(303);
    expect(await db.query.brands.findFirst({ where: and(eq(brands.workspace_id, workspaceId), eq(brands.key, "tsa")) })).toBeUndefined();
    expect((await db.query.channels.findFirst({ where: eq(channels.id, yt) }))!.brand_key).toBeNull();
  });

  it("a brand's slot assignment NEVER touches another workspace's channel", async () => {
    if (!TEST_DB) return;
    // A channel in ANOTHER workspace must be invisible to this workspace's slot assignment.
    const otherWs = (await db.insert(workspaces).values({ name: "Other", slug: `other-${Math.random().toString(36).slice(2)}` }).returning())[0].id;
    const [foreign] = await db.insert(channels).values({ workspace_id: otherWs, platform: "youtube", platform_id: "UC-FOREIGN", token_encrypted: encryptTokens({ access_token: "T" }), webhook_secret: "w" }).returning({ id: channels.id });
    await createBrandSvc({ key: "tsa", name: "TSA" }, workspaceId);
    const res = await app.request("/brands/tsa/slot/youtube", {
      method: "PUT", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channelId: foreign!.id }),
    });
    expect(res.status).toBe(404); // not found in this workspace
    expect((await db.query.channels.findFirst({ where: eq(channels.id, foreign!.id) }))!.brand_key).toBeNull();
    await db.delete(workspaces).where(eq(workspaces.id, otherWs));
  });
});

describe("Channels grouped by brand", () => {
  it("shows brand group headers and an Unassigned group", async () => {
    if (!TEST_DB) return;
    await createBrandSvc({ key: "tsa", name: "Tech Skills Academy" }, workspaceId);
    const yt = await makeChannel("youtube", "UC1");
    await db.update(channels).set({ brand_key: "tsa" }).where(eq(channels.id, yt));
    await makeChannel("tiktok", "tt-orphan");
    const out = await (await app.request("/channels", { headers: { cookie } })).text();
    expect(out).toContain("Tech Skills Academy");
    expect(out).toContain("Unassigned");
    expect(out).toContain('name="brandKey"');
  });
});
