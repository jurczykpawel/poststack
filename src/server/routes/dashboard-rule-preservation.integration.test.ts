import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

const WS = "eeeeeeee-0000-0000-0000-0000000000e1";
const USER = "eeeeeeee-0000-0000-0000-0000000000e2";

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
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function get(path: string) {
  return app.request(path, { headers: { cookie } });
}
function postJson(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "hx-request": "true" },
    body: JSON.stringify(body),
  });
}

describe("Rule editor preservation", () => {
  it("duplicates and edits without changing rule settings", async () => {
    const { encryptTokens } = await import("@/lib/crypto");
    const [channel] = await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: "rule-preservation", webhook_secret: "test", token_encrypted: encryptTokens({ access_token: "test" }), status: "active" }).returning();
    const [source] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, channel_id: channel!.id, name: "Original", trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hello", match_type: "exact" }] },
      response_type: "text", response_config: { text: "Reply", ai_rephrase: true, tone: "warm",
        quick_replies: [{ content_type: "text", title: "Next", payload: "NEXT", image_url: "https://example.com/a.png" }] },
      priority: 99, cooldown_seconds: 3600, max_sends_per_contact: 1, requires_approval: true, is_active: false,
    }).returning();
    const form = await (await get(`/rules/${source!.id}/duplicate`)).text();
    expect(form).toContain('name="source_rule_id"');
    const res = await postJson("/rules", { source_rule_id: source!.id, name: "Copy", channel_id: channel!.id, keywords: "copy", trigger_type: "keyword", response_mode: "text", text: "Reply", requires_approval: "true" });
    expect(await res.text()).not.toContain("notice-err");
    const copy = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.name, "Copy") });
    expect(copy).toMatchObject({ channel_id: channel!.id, priority: 99, cooldown_seconds: 3600, max_sends_per_contact: 1, requires_approval: true, is_active: false,
      trigger_config: { keywords: [{ value: "copy", match_type: "exact" }] }, response_config: source!.response_config });
    await postJson(`/rules/${source!.id}`, { name: "Original", channel_id: channel!.id, keywords: "hello", text: "Changed", requires_approval: "true" });
    const edited = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, source!.id) });
    expect(edited).toMatchObject({ ...source!, response_config: { ...source!.response_config as object, text: "Changed" }, updated_at: expect.any(Date) });
  });
  it.each([
    ["story_reply", "random_text", {}, { messages: ["One", "Two"], add_tags: ["lead"] }],
    ["reaction", "none", { reactions: ["love"] }, { add_tags: ["fan"] }],
    ["postback", "follow_gate", { payload: "OPEN" }, { followed: { text: "Thanks", quick_replies: [{ content_type: "user_email" }] }, not_followed: { text: "Follow first", buttons: [{ title: "Claim", payload: "CUSTOM" }, { title: "Open", payload: "OPEN" }] } }],
  ])("duplicates %s → %s with its full configuration", async (trigger, response, tc, rc) => {
    const [source] = await db.insert(s.autoReplyRules).values({ workspace_id: WS, name: "Advanced", trigger_type: trigger as "story_reply", response_type: response as "random_text", trigger_config: tc, response_config: rc }).returning();
    const form = await (await get(`/rules/${source!.id}/duplicate`)).text();
    expect(form).toContain('name="source_rule_id"');
    const res = await postJson("/rules", { source_rule_id: source!.id, name: "Advanced copy", trigger_type: trigger, response_mode: response, payload: "OPEN", followed_text: "Thanks", not_followed_text: "Follow first", claim_label: "Claim" });
    expect(await res.text()).not.toContain("notice-err");
    const copy = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.name, "Advanced copy") });
    expect(copy).toMatchObject({ trigger_type: trigger, response_type: response, trigger_config: tc, response_config: rc });
  });

});
