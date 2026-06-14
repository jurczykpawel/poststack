import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { users, workspaces, channels, brands, content, posts, rateLimitCounters } from "@/db/schema";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "compose-ui@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
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
  await licenseInstance(); // all-access (publishing entitled)

  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) {
    await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  }
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(rateLimitCounters); // the register rate-limit is DB-backed + shared across files
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

  // A brand with an Instagram + YouTube channel so the compose page lists those platforms.
  await db.insert(brands).values({ workspace_id: workspaceId, key: "techskills.academy", name: "Tech Skills Academy" });
  await db.insert(channels).values([
    { workspace_id: workspaceId, platform: "instagram", platform_id: "ig1", display_name: "@tsa", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w1", status: "active" },
    { workspace_id: workspaceId, platform: "youtube", platform_id: "UC1", display_name: "TSA YT", brand_key: "techskills.academy", token_encrypted: encryptTokens({ access_token: "t" }), webhook_secret: "w2", status: "active" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

describe("unified Compose section", () => {
  it("redirects to login without a session", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/compose")).status).toBe(302);
  });

  it("renders the authoring page with the Alpine component + embedded brand data", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/compose", { headers: { cookie } });
    expect(res.status).toBe(200);
    const out = await res.text();
    expect(out).toContain("psCompose(");
    expect(out).toContain("ps-compose-data");
    expect(out).toContain("Create &"); // primary action
    expect(out).toContain("Tech Skills Academy"); // brand embedded
    expect(out).toContain('<option value="techskills.academy">Tech Skills Academy</option>');
    expect(out).toContain("instagram"); // available platform embedded
  });

  it("POST creates a draft content + planned posts and redirects to the cockpit", async () => {
    if (!TEST_DB) return;
    const payload = {
      brand: "techskills.academy",
      title: "AI w terminalu",
      contentType: "reel",
      mediaUrl: "https://cdn/reel.mp4",
      coverUrl: "https://cdn/cover.png",
      baseDescription: "Base caption",
      baseHashtags: "#ai",
      posts: [{ platform: "instagram" }, { platform: "youtube", description: "YT caption" }],
    };
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify(payload) }),
    });
    expect(res.status).toBe(303);
    const loc = res.headers.get("location")!;
    expect(loc).toMatch(/^\/content\/[0-9a-f-]+$/);

    const id = loc.split("/").pop()!;
    const row = await db.query.content.findFirst({ where: eq(content.id, id) });
    expect(row!.status).toBe("draft");
    expect(row!.profile).toBe("techskills.academy");
    const ps = await db.query.posts.findMany({ where: eq(posts.content_id, id) });
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => p.status === "planned")).toBe(true);
    expect(ps.find((p) => p.platform === "youtube")!.description).toBe("YT caption");
    expect(ps.find((p) => p.platform === "instagram")!.description).toBe("Base caption");
    expect(ps.every((p) => p.video_url === "https://cdn/reel.mp4")).toBe(true);
  });

  it("rejects a malformed payload with 400", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/compose", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payload: JSON.stringify({ title: "x" }) }),
    });
    expect(res.status).toBe(400);
  });
});
