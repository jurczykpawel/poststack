import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// ADLOG1: the /settings "Automation" tab surfaces the workspace's recent AI generations (drafts +
// rephrases) — PRO-gated (ai_draft OR ai_rephrase), workspace-scoped, newest first.
const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

const WS = "eeeeeeee-0000-0000-0000-0000000000e1";
const USER = "eeeeeeee-0000-0000-0000-0000000000e2";
const OTHER_WS = "eeeeeeee-0000-0000-0000-0000000000e3";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER_WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values([
    { id: WS, name: "M", slug: `m-${WS}` },
    { id: OTHER_WS, name: "O", slug: `o-${OTHER_WS}` },
  ]);
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER_WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function get(path: string) {
  return app.request(path, { headers: { cookie } });
}

async function seedLog(workspaceId: string, over: Partial<typeof s.aiGenerationLogs.$inferInsert> = {}) {
  await db.insert(s.aiGenerationLogs).values({
    workspace_id: workspaceId,
    kind: "draft",
    model: "gpt-4o-mini",
    system_prompt: "SYS_MARKER",
    user_message: "Congratulations 🎉",
    response: "Thank you!",
    error: null,
    duration_ms: 500,
    ...over,
  });
}

async function seedConversation(workspaceId: string): Promise<string> {
  const [ch] = await db
    .insert(s.channels)
    .values({ workspace_id: workspaceId, platform: "facebook", platform_id: `PG-${Math.random()}`, token_encrypted: "x", webhook_secret: "s" })
    .returning({ id: s.channels.id });
  const [contact] = await db.insert(s.contacts).values({ workspace_id: workspaceId }).returning({ id: s.contacts.id });
  const [conv] = await db
    .insert(s.conversations)
    .values({ workspace_id: workspaceId, channel_id: ch!.id, contact_id: contact!.id, platform: "facebook", status: "open" })
    .returning({ id: s.conversations.id });
  return conv!.id;
}

describe("GET /settings — AI generation log (ADLOG1)", () => {
  it("PRO: renders recent generations with model/kind/response, newest first", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { user_message: "OLDER", created_at: new Date(Date.now() - 60_000) });
    await seedLog(WS, { user_message: "NEWER" });
    const html = await (await get("/settings")).text();
    expect(html).toContain("gpt-4o-mini");
    expect(html).toContain("NEWER");
    expect(html).toContain("OLDER");
    expect(html.indexOf("NEWER")).toBeLessThan(html.indexOf("OLDER")); // newest first
  });

  it("PRO: shows the empty state when there are no generations yet", async () => {
    if (!TEST_DB) return;
    const html = await (await get("/settings")).text();
    expect(html).toContain("No AI generations yet");
  });

  it("is workspace-scoped: another workspace's log never appears", async () => {
    if (!TEST_DB) return;
    await seedLog(OTHER_WS, { user_message: "FOREIGN_MARKER" });
    const html = await (await get("/settings")).text();
    expect(html).not.toContain("FOREIGN_MARKER");
  });

  it("free instance: shows a PRO upsell, no log rows", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { user_message: "SHOULD_NOT_APPEAR" });
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const html = await (await get("/settings")).text();
    expect(html).not.toContain("SHOULD_NOT_APPEAR");
    expect(html).toContain("AI generation log");
  });

  // ADLOG2: a row links straight to the inbox conversation it was generated for.
  it("links a row to /inbox/:id when it has a conversation_id", async () => {
    if (!TEST_DB) return;
    const convId = await seedConversation(WS);
    await seedLog(WS, { conversation_id: convId });
    const html = await (await get("/settings")).text();
    expect(html).toContain(`href="/inbox/${convId}"`);
  });

  it("renders no conversation link for a row with no conversation_id (e.g. a rule preview)", async () => {
    if (!TEST_DB) return;
    await seedLog(WS);
    const html = await (await get("/settings")).text();
    expect(html).not.toContain('href="/inbox/');
  });
});
