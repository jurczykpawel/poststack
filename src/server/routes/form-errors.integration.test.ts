import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "eeeeeeee-0000-0000-0000-0000000000f1";
const USER = "eeeeeeee-0000-0000-0000-0000000000f2";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

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
  app = (await import("../app")).buildApp();
  cookie = `session=${await (await import("@/lib/auth")).signSession(USER, WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "F", slug: `f-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

const hx = () => ({ cookie, "hx-request": "true" });

describe.skipIf(!TEST_DB)("G42 — validation errors keep the form open (htmx 422 fragments)", () => {
  it("B07: bad brand key over htmx → 422 fragment with the message, no page reload; the key input carries the server pattern", async () => {
    const res = await app.request("/brands", { method: "POST", headers: { ...hx(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: "bad key'/x", name: "Kept name" }) });
    expect(res.status).toBe(422);
    const body = await res.text();
    expect(body).toContain("Brand key may contain only");
    expect(body).not.toContain("<html");
    const page = await (await app.request("/brands", { headers: { cookie } })).text();
    expect(page).toMatch(/name="key"[^>]*pattern="\[A-Za-z0-9\]\[A-Za-z0-9\._\\-\]\*"/);
    expect(page).toContain('hx-post="/brands"');
  });

  it("B07: valid brand over htmx → HX-Redirect to /brands", async () => {
    const res = await app.request("/brands", { method: "POST", headers: { ...hx(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: "ok.brand", name: "Ok" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("hx-redirect")).toBe("/brands");
  });

  it("B08: invalid rule edit → 422 with the field message, retargeted to the form's error slot", async () => {
    const { encryptTokens } = await import("@/lib/crypto");
    const [channel] = await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: "g42-rule", webhook_secret: "t", token_encrypted: encryptTokens({ access_token: "t" }), status: "active" }).returning();
    const [rule] = await db.insert(s.autoReplyRules).values({ workspace_id: WS, channel_id: channel!.id, name: "R", trigger_type: "keyword", trigger_config: { keywords: [{ value: "hi", match_type: "exact" }] }, response_type: "text", response_config: { text: "Reply" } }).returning();
    const res = await app.request(`/rules/${rule!.id}`, { method: "POST", headers: { ...hx(), "content-type": "application/json" }, body: JSON.stringify({ name: "R", channel_id: channel!.id, keywords: "hi", text: "" }) });
    expect(res.status).toBe(422);
    expect(res.headers.get("hx-retarget")).toBe(`#rule-err-${rule!.id}`);
    const body = await res.text();
    expect(body).toContain("notice-err");
    expect(body).not.toContain("Invalid request data");
    const form = await (await app.request(`/rules/${rule!.id}/edit`, { headers: { cookie } })).text();
    expect(form).toContain(`id="rule-err-${rule!.id}"`);
  });

  it("B09: fallback form shows its message in place and reloads only on success", async () => {
    const { problemAlertsCard } = await import("../ui/sections/problem-alerts");
    const card = String(problemAlertsCard(null, true, "https://x", { key: "CHANNEL_ALERT_WEBHOOK_URL", source: "none", preview: null } as never));
    expect(card).toContain("data-alert-fallback-msg");
    expect(card).toContain("event.detail.successful");
    expect(card).not.toContain('@htmx:after-request="location.reload()"');
  });

  it("global: htmx swaps 422 responses (htmx 2 drops 4xx by default)", async () => {
    const page = await (await app.request("/brands", { headers: { cookie } })).text();
    expect(page).toContain("responseHandling");
    expect(page).toContain("422");
  });

  it("OVSENT1: Sent cards link to Activity → Sent replies and the row counts equal the card numbers", async () => {
    const { encryptTokens } = await import("@/lib/crypto");
    const [ch] = await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: "g42-sent", webhook_secret: "t", token_encrypted: encryptTokens({ access_token: "t" }), status: "active" }).returning();
    const now = new Date();
    const old = new Date(Date.now() - 3 * 86_400_000);
    const row = (key: string, status: "sent" | "failed", created_at: Date) => ({ delivery_key: `g42-${key}`, workspace_id: WS, channel_id: ch!.id, task_name: "outgoing-message", status, payload: {}, created_at });
    await db.insert(s.outboundDeliveries).values([row("a", "sent", now), row("b", "sent", now), row("c", "sent", old), row("d", "failed", now)]);
    const { loadOverview } = await import("@/lib/stats/overview");
    const ov = await loadOverview(WS);
    expect([ov.today, ov.sent]).toEqual([2, 3]);
    const overview = await (await app.request("/overview", { headers: { cookie } })).text();
    expect(overview).toContain('href="/activity?source=sent&amp;range=today"');
    expect(overview).toContain('href="/activity?source=sent"');
    const all = await (await app.request("/activity?source=sent", { headers: { cookie } })).text();
    expect(all).toMatch(/of 3\b/);
    const todayList = await (await app.request("/activity?source=sent&range=today", { headers: { cookie } })).text();
    expect(todayList).toMatch(/of 2\b/);
  });
});
