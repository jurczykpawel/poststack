import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import { API_SCOPES } from "@/lib/auth/scopes";

// UXFLOW1 stage 7: Settings as separate addresses under top tabs, API keys list-first with a create
// sheet, Integrations as a service list + one-service view saved in one request, AI page, Sources on
// Channels. Contract for the owner: every old #hash still lands on the right page.

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "dddddddd-0000-0000-0000-0000000007a1";
const USER = "dddddddd-0000-0000-0000-0000000007a2";
const OTHER_WS = "dddddddd-0000-0000-0000-0000000007a3";
const OTHER_USER = "dddddddd-0000-0000-0000-0000000007a4";
const KEYS = ["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "ALTCHA_HMAC_KEY"];

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;
let otherCookie: string;
let invalidate: () => void;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { env } = await import("@/lib/env");
  Object.assign(env, { INSTANCE_ADMIN_EMAILS: `u-${USER}@test.local` });
  ({ invalidateConfigCache: invalidate } = await import("@/lib/settings/config"));
  const { buildApp } = await import("../../../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  otherCookie = `session=${await signSession(OTHER_USER, OTHER_WS)}`;
  await licenseInstance();
});

async function resetPeople() {
  for (const [w, u] of [[WS, USER], [OTHER_WS, OTHER_USER]]) {
    await db.delete(s.workspaces).where(eq(s.workspaces.id, w));
    await db.delete(s.users).where(eq(s.users.id, u));
  }
}

beforeEach(async () => {
  if (!TEST_DB) return;
  await resetPeople();
  for (const [w, u] of [[WS, USER], [OTHER_WS, OTHER_USER]]) {
    await db.insert(s.users).values({ id: u, email: `u-${u}@test.local` });
    await db.insert(s.workspaces).values({ id: w, name: "Settings", slug: `st-${w}` });
    await db.insert(s.workspaceMembers).values({ workspace_id: w, user_id: u, role: "owner" });
  }
  await db.delete(s.instanceSettings).where(inArray(s.instanceSettings.key, KEYS));
  invalidate();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.instanceSettings).where(inArray(s.instanceSettings.key, KEYS));
  await resetPeople();
  invalidate();
  await db.$client.end();
});

const get = (path: string, as = cookie) => app.request(path, { headers: { cookie: as } });
const text = async (path: string, as = cookie) => (await get(path, as)).text();
const postJson = (path: string, body: unknown, as = cookie) =>
  app.request(path, { method: "POST", headers: { cookie: as, "content-type": "application/json" }, body: JSON.stringify(body) });
const stored = async () => (await db.select().from(s.instanceSettings).where(inArray(s.instanceSettings.key, KEYS))).map((r) => r.key).sort();

describe("Settings addresses", () => {
  it("/settings, /api-keys and /sources land on their new addresses", async () => {
    if (!TEST_DB) return;
    for (const [from, to] of [["/settings", "/settings/account"], ["/api-keys", "/settings/api-keys"], ["/sources", "/channels#sources"]]) {
      const res = await get(from);
      expect(res.status, from).toBe(302);
      expect(res.headers.get("location"), from).toBe(to);
    }
  });

  it("every page has the top tabs with the current one marked, and maps the old #hashes", async () => {
    if (!TEST_DB) return;
    for (const [path, label] of [["/settings/account", "Account"], ["/settings/api-keys", "API keys"], ["/settings/ai", "AI"], ["/settings/data", "Data"], ["/settings/integrations", "Integrations"], ["/settings/license", "License"]]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain(`class="settings-tab active" aria-current="page" href="${path}">${label}</a>`);
      expect(body.match(/class="settings-tab[ "]/g)?.length, path).toBe(6);
      expect(body, path).not.toContain('class="settings-panel" x-show'); // no client-side tab switching
      for (const legacy of ['apikeys:"/settings/api-keys"', 'automation:"/settings/ai"', 'sources:"/channels#sources"', 'alert:"/webhooks#outgoing"', 'integrations:"/settings/integrations"']) {
        expect(body, path).toContain(legacy);
      }
    }
    expect((await get("/settings/nope")).status).toBe(404);
  });

  it("a member who is not the instance operator sees only the workspace tabs", async () => {
    if (!TEST_DB) return;
    const body = await text("/settings/account", otherCookie);
    expect(body.match(/class="settings-tab[ "]/g)?.length).toBe(4);
    expect(body).not.toContain('href="/settings/integrations"');
    const integrations = await text("/settings/integrations", otherCookie);
    expect(integrations).toContain("Managed by the instance operator");
    expect(integrations).not.toContain("META_APP_SECRET");
    expect((await get("/settings/integrations/meta", otherCookie)).status).toBe(403);
  });
});

describe("API keys page", () => {
  it("shows the key list first and creates keys in a sheet with presets and a compact Read/Write table", async () => {
    if (!TEST_DB) return;
    const body = await text("/settings/api-keys");
    expect(body.indexOf('id="keys-area"')).toBeGreaterThan(-1);
    expect(body.indexOf('id="keys-area"')).toBeLessThan(body.indexOf('<dialog id="api-key-sheet"'));
    expect(body).toContain(" Create API key</button>");
    for (const label of ["Read only", "Publishing", "Inbox &amp; automation", "Custom"]) expect(body).toContain(`<b>${label}</b>`);
    const rendered = [...body.matchAll(/data-api-scope type="checkbox" value="([^"]+)"/g)].map((m) => m[1]);
    expect([...rendered].sort()).toEqual([...API_SCOPES].sort());
    expect(body).toContain('<th scope="col">Read</th><th scope="col">Write</th>');
    expect(body).toContain('hx-post="/settings/api-keys"');
  });
});

describe("Integrations", () => {
  it("lists every service with its state, and opens one service as steps", async () => {
    if (!TEST_DB) return;
    const list = await text("/settings/integrations");
    for (const name of ["Meta", "Google", "TikTok", "LinkedIn", "X", "Threads", "AI provider", "ReelStack", "Login protection", "Instance branding"]) {
      expect(list).toContain(`<span class="int-name">${name}</span>`);
    }
    const meta = await text("/settings/integrations/meta");
    expect(meta).toContain("http://localhost:3000/api/oauth/facebook/callback");
    expect(meta).toContain("http://localhost:3000/api/oauth/instagram-login/callback");
    expect(meta).toContain("http://localhost:3000/api/webhooks/meta");
    expect(meta.match(/hx-post="\/settings\/integrations\/meta"/g)?.length).toBe(1); // one form, one save
    expect(meta).toContain('name="META_APP_SECRET"');
    expect(meta).toContain('name="INSTAGRAM_APP_SECRET"');
    expect(meta).not.toContain('name="GOOGLE_CLIENT_ID"');
    const google = await text("/settings/integrations/google");
    expect(google).toContain("http://localhost:3000/api/oauth/youtube/callback");
    expect(google).toContain("http://localhost:3000/api/oauth/gmail/callback");
    const tiktok = await text("/settings/integrations/tiktok");
    expect(tiktok).toContain("http://localhost:3000/api/oauth/connect/tiktok/callback");
    expect(tiktok).toContain("TIKTOK_CLIENT_KEY");
    expect(tiktok).toContain("TikTok: always confirm at send");
    expect((await get("/settings/integrations/nope")).status).toBe(404);
  });

  it("saves a group of credentials in one request, keeps blank fields, clears one field on request", async () => {
    if (!TEST_DB) return;
    const res = await postJson("/settings/integrations/meta", { META_APP_ID: "app-77", META_APP_SECRET: "sec-77", META_WEBHOOK_VERIFY_TOKEN: "" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Saved 2 values.");
    expect(body).not.toContain("sec-77");
    expect(await stored()).toEqual(["META_APP_ID", "META_APP_SECRET"]);

    await postJson("/settings/integrations/meta", { META_APP_ID: "", META_APP_SECRET: "" });
    expect(await stored()).toEqual(["META_APP_ID", "META_APP_SECRET"]); // blank = unchanged

    const cleared = await postJson("/settings/integrations/meta", { clear: "META_APP_SECRET", META_APP_ID: "ignored-on-clear" });
    expect(await cleared.text()).toContain("Reverted to the environment variable.");
    expect(await stored()).toEqual(["META_APP_ID"]);
    const { getConfig } = await import("@/lib/settings/config");
    expect(await getConfig("META_APP_ID")).toBe("app-77");
  });

  it("refuses keys from another service, and non-operators write nothing", async () => {
    if (!TEST_DB) return;
    await postJson("/settings/integrations/meta", { ALTCHA_HMAC_KEY: "x" });
    expect(await stored()).toEqual([]);
    const res = await postJson("/settings/integrations/meta", { META_APP_ID: "evil" }, otherCookie);
    expect(res.status).toBe(403);
    expect(await stored()).toEqual([]);
  });
});

describe("AI page and Sources on Channels", () => {
  it("AI holds the default prompts and the log summary, nothing about alerts", async () => {
    if (!TEST_DB) return;
    const body = await text("/settings/ai");
    expect(body).toContain('hx-post="/settings/ai-draft-prompt"');
    expect(body).toContain('hx-post="/settings/ai-rephrase-prompt"');
    expect(body).toContain('href="/activity?source=ai"');
    expect(body).not.toContain("alert-webhook");
  });

  it("Channels carries the managed-connection manager", async () => {
    if (!TEST_DB) return;
    const body = await text("/channels");
    expect(body).toContain('id="sources"');
    expect(body).toContain("Connect all");
    expect(body).toContain('id="sources-list"');
  });
});
