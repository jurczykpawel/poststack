import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";

// FBSTORY1: the Auto-Story panel of a Facebook channel links to that Page's reel composer (page id
// from the channel row) and to the guide; Instagram channels get no such hint.

vi.mock("@/lib/queue/client", () => ({
  addJob: vi.fn(async () => {}),
  addJobTx: vi.fn(async () => {}),
  closeQueue: async () => {},
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "fb570000-0000-0000-0000-0000000000a1";
const USER = "fb570000-0000-0000-0000-0000000000a2";
const CH_FB = "fb570000-0000-0000-0000-0000000000a3";
const CH_IG = "fb570000-0000-0000-0000-0000000000a4";
const PAGE_ID = "104857600123456";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

async function cleanup(): Promise<void> {
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspace_id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
}

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
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await cleanup();
  await db.insert(s.users).values({ id: USER, email: `u-fbstory-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "FB reel Story WS", slug: `fbstory-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values([
    { id: CH_FB, workspace_id: WS, platform: "facebook", platform_id: PAGE_ID, token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth" },
    { id: CH_IG, workspace_id: WS, platform: "instagram", platform_id: "17841400000000001", token_encrypted: "x", webhook_secret: "s", status: "active", connection_mode: "oauth" },
  ]);
});

afterAll(async () => {
  if (!TEST_DB) return;
  await cleanup();
  await db.$client.end?.();
});

describe("channel detail — Facebook reel-to-Story hint", () => {
  it("links a Facebook channel to its own Page's reel composer and the guide", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/channels/${CH_FB}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("data-fb-reel-story-hint");
    expect(body).toContain(`https://business.facebook.com/latest/reels_composer/?asset_id=${PAGE_ID}`);
    expect(body).toContain("docs/STORIES.md#facebook-adds-a-shortened-reel-preview-to-your-story");
  });

  it("shows no hint for an Instagram channel", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/channels/${CH_IG}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("story-panel");
    expect(body).not.toContain("data-fb-reel-story-hint");
    expect(body).not.toContain("reels_composer");
  });
});
