import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// ADLOG1 → UXFLOW1 stage 3: the AI generations (drafts + rephrases) are the `ai` source of /activity —
// PRO-gated (ai_draft OR ai_rephrase), workspace-scoped, newest first. Settings → Automation only links to it.
const AI = "/activity?source=ai";
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

describe("GET /activity?source=ai — AI generation log (ADLOG1)", () => {
  it("PRO: lists generations newest first with kind, model and the response start", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { response: "OLDER_RESP", created_at: new Date(Date.now() - 60_000) });
    await seedLog(WS, { response: "NEWER_RESP" });
    const html = await (await get(AI)).text();
    expect(html).toContain("gpt-4o-mini");
    expect(html.indexOf("NEWER_RESP")).toBeGreaterThan(-1);
    expect(html.indexOf("NEWER_RESP")).toBeLessThan(html.indexOf("OLDER_RESP"));
    expect(html).not.toContain("SYS_MARKER"); // the prompts are in the details, not the list
  });

  it("PRO: shows the empty state when there are no generations yet", async () => {
    if (!TEST_DB) return;
    expect(await (await get(AI)).text()).toContain("No AI generations yet");
  });

  it("is workspace-scoped: another workspace's log never appears, even opened by id", async () => {
    if (!TEST_DB) return;
    await seedLog(OTHER_WS, { user_message: "FOREIGN_MARKER", response: "FOREIGN_RESP" });
    const foreign = await db.query.aiGenerationLogs.findFirst({ where: eq(s.aiGenerationLogs.workspace_id, OTHER_WS) });
    const html = await (await get(AI)).text();
    expect(html).not.toContain("FOREIGN_RESP");
    expect(await (await get(`${AI}&open=${foreign!.id}`)).text()).not.toContain("FOREIGN_MARKER");
  });

  it("chips split OK and failed, filter by result, kind and model, and search the prompt", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { response: "fine one", model: "m-a" });
    await seedLog(WS, { response: "fine two", model: "m-b", kind: "rephrase", user_message: "needle text" });
    await seedLog(WS, { response: null, error: "Provider timeout", model: "m-a" });
    const all = await (await get(AI)).text();
    expect(all).toMatch(/class="dl-chip[^"]*"[^>]*>\s*OK\s*<b>2<\/b>/);
    expect(all).toMatch(/class="dl-chip[^"]*"[^>]*>\s*Failed\s*<b>1<\/b>/);
    const failed = await (await get(`${AI}&result=failed`)).text();
    expect(failed).toContain("Provider timeout");
    expect(failed).not.toContain("fine one");
    const rephrase = await (await get(`${AI}&kind=rephrase`)).text();
    expect(rephrase).toContain("fine two");
    expect(rephrase).not.toContain("fine one");
    expect(await (await get(`${AI}&model=m-b`)).text()).not.toContain("fine one");
    const found = await (await get(`${AI}&q=needle`)).text();
    expect(found).toContain("fine two");
    expect(found).not.toContain("Provider timeout");
  });

  it("opens a generation: full system prompt, user message, response, escaped", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { system_prompt: "SYS_MARKER", user_message: "<script>alert(1)</script>", response: "RESP_MARKER" });
    const row = await db.query.aiGenerationLogs.findFirst({ where: eq(s.aiGenerationLogs.workspace_id, WS) });
    const html = await (await get(`${AI}&open=${row!.id}`)).text();
    expect(html).toContain("SYS_MARKER");
    expect(html).toContain("RESP_MARKER");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("free instance: shows a PRO upsell, no log rows", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { response: "SHOULD_NOT_APPEAR" });
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const html = await (await get(AI)).text();
    expect(html).not.toContain("SHOULD_NOT_APPEAR");
    expect(html).toContain("PRO");
  });

  // ADLOG2: a generation links straight to the inbox conversation it was made for.
  it("links the opened generation to /inbox/:id when it has a conversation_id", async () => {
    if (!TEST_DB) return;
    const convId = await seedConversation(WS);
    await seedLog(WS, { conversation_id: convId });
    const row = await db.query.aiGenerationLogs.findFirst({ where: eq(s.aiGenerationLogs.workspace_id, WS) });
    expect(await (await get(`${AI}&open=${row!.id}`)).text()).toContain(`href="/inbox/${convId}"`);
  });

  it("renders no conversation link for a generation with no conversation_id (e.g. a rule preview)", async () => {
    if (!TEST_DB) return;
    await seedLog(WS);
    const row = await db.query.aiGenerationLogs.findFirst({ where: eq(s.aiGenerationLogs.workspace_id, WS) });
    expect(await (await get(`${AI}&open=${row!.id}`)).text()).not.toContain('href="/inbox/');
  });
});

describe("GET /settings — AI log summary", () => {
  it("PRO: counts generations and this week's failures and links to Activity, without listing rows", async () => {
    if (!TEST_DB) return;
    await seedLog(WS, { response: "ROW_IN_SETTINGS" });
    await seedLog(WS, { response: null, error: "boom" });
    await seedLog(WS, { response: null, error: "old failure", created_at: new Date(Date.now() - 10 * 86_400_000) });
    const html = await (await get("/settings")).text();
    expect(html).toContain("3 generations, 1 failed this week.");
    expect(html).toContain('href="/activity?source=ai"');
    expect(html).not.toContain("ROW_IN_SETTINGS");
  });

  it("free instance: PRO upsell, no counts", async () => {
    if (!TEST_DB) return;
    await seedLog(WS);
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const html = await (await get("/settings")).text();
    expect(html).toContain("AI generation log");
    expect(html).not.toContain("1 generations");
  });
});
