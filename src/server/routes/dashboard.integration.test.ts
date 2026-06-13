import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let cookie: string;

const WS = "dddddddd-0000-0000-0000-0000000000a1";
const USER = "dddddddd-0000-0000-0000-0000000000a2";
const CH = "dddddddd-0000-0000-0000-0000000000a3";
const CONTACT = "dddddddd-0000-0000-0000-0000000000a4";
const CONV = "dddddddd-0000-0000-0000-0000000000a5";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `rs_session=${await signSession(USER, WS)}`;
  await licenseInstance(); // dashboard builds sequences / interactive rules (PRO)
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-D", token_encrypted: "x", webhook_secret: "s", status: "active" });
  await db.insert(s.contacts).values({ id: CONTACT, workspace_id: WS });
  await db.insert(s.contactChannels).values({ contact_id: CONTACT, channel_id: CH, platform_sender_id: "PSID-D" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook" });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

function reply(text: string) {
  return app.request(`/inbox/${CONV}/reply`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function setRetention(value: unknown) {
  return app.request("/settings/retention", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ message_retention_days: value }),
  });
}

async function retentionDays(): Promise<number | null> {
  const [w] = await db.select().from(s.workspaces).where(eq(s.workspaces.id, WS));
  return w.message_retention_days;
}

describe("dashboard /inbox/:id/reply — surfaces send failures", () => {
  it("shows an error notice and keeps the draft when the send is rejected", async () => {
    if (!TEST_DB) return;
    const draft = "x".repeat(2500); // over the 2000-char limit → validation error
    const res = await reply(draft);
    const body = await res.text();
    expect(body).toContain("notice-err");
    // The typed message must NOT be silently discarded.
    expect(body).toContain(draft);
  });

  it("re-renders the thread with no error notice when the reply is accepted", async () => {
    if (!TEST_DB) return;
    const res = await reply("thanks!");
    const body = await res.text();
    expect(body).not.toContain("notice-err");
  });
});

describe("dashboard /settings/retention — validates days", () => {
  it.each([0, -5, 1.5])("rejects %s and leaves the policy unchanged", async (bad) => {
    if (!TEST_DB) return;
    const res = await setRetention(bad);
    const body = await res.text();
    expect(body).not.toContain("Saved.");
    expect(await retentionDays()).toBeNull();
  });

  it("accepts a positive whole number of days", async () => {
    if (!TEST_DB) return;
    const res = await setRetention(30);
    const body = await res.text();
    expect(body).toContain("Saved.");
    expect(await retentionDays()).toBe(30);
  });
});

describe("dashboard action error surfacing", () => {
  it("shows an error notice when an approval action fails (instead of silently re-rendering)", async () => {
    if (!TEST_DB) return;
    // A non-existent approval id → the delegated approve returns 404 → the dashboard must surface it.
    const res = await app.request("/approvals/dddddddd-0000-4000-8000-00000000aa01/approve", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(res.status).toBe(200); // htmx swap renders the list
    expect(await res.text()).toContain("notice-err");
  });
});

describe("dashboard rule builder", () => {
  it("ignores a stale hidden postback payload when the trigger is not postback", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "K-106", trigger_type: "keyword", keywords: "hi", payload: "STALE_PAYLOAD", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.name, "K-106") });
    expect(rule).toBeTruthy();
    expect((rule!.trigger_config as Record<string, unknown>).payload).toBeUndefined();
  });
});

describe("dashboard inbox conversation controls", () => {
  it("pauses automation from the inbox via the control route", async () => {
    if (!TEST_DB) return;
    const res = await app.request(`/inbox/${CONV}/conversation`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ is_automation_paused: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Resume automation");
    const conv = await db.query.conversations.findFirst({ where: eq(s.conversations.id, CONV), columns: { is_automation_paused: true } });
    expect(conv?.is_automation_paused).toBe(true);
  });

  it("shows a contact's reaction interleaved in the thread", async () => {
    if (!TEST_DB) return;
    await db.insert(s.messageReactions).values({
      workspace_id: WS, channel_id: CH, conversation_id: CONV, contact_id: CONTACT,
      reacted_mid: "m-thread", reaction_type: "love", emoji: "❤️",
    });
    const res = await app.request(`/inbox/${CONV}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("reacted ❤️");
  });
});

describe("dashboard sequence builder", () => {
  it("creates a sequence with a typed delay step from steps_json", async () => {
    if (!TEST_DB) return;
    const stepsJson = JSON.stringify([{ type: "message", content: "Hi" }, { type: "delay", delay_minutes: 120 }, { type: "message", content: "Bye" }]);
    const res = await app.request("/sequences", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Drip-114", steps_json: stepsJson }),
    });
    expect(res.status).toBe(200);
    const seq = await db.query.sequences.findFirst({ where: eq(s.sequences.name, "Drip-114"), columns: { steps: true } });
    const steps = seq!.steps as Array<{ type: string; delay_minutes?: number }>;
    expect(steps.map((x) => x.type)).toEqual(["message", "delay", "message"]);
    expect(steps[1].delay_minutes).toBe(120);
  });
});

describe("dashboard API key scopes", () => {
  it("creates a scoped key (not full-access) from the selected scopes", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Scoped-117", scopes_json: JSON.stringify(["contacts:read", "conversations:read"]) }),
    });
    expect(res.status).toBe(200);
    const key = await db.query.apiKeys.findFirst({ where: eq(s.apiKeys.name, "Scoped-117"), columns: { scopes: true } });
    expect(key?.scopes).toEqual(["contacts:read", "conversations:read"]);
  });

  // deselecting every scope must NOT mint a full-access key (empty = full-access sentinel).
  it("rejects an all-deselected (empty) scope set instead of creating a full-access key", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings/api-keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Empty-130", scopes_json: JSON.stringify([]) }),
    });
    expect(res.status).toBe(200); // re-renders the form area with a notice, no key created
    const key = await db.query.apiKeys.findFirst({ where: eq(s.apiKeys.name, "Empty-130"), columns: { id: true } });
    expect(key).toBeUndefined();
  });
});

describe("settings — Meta App config + alert webhook UI", () => {
  it("shows copy-ready OAuth redirect URIs + webhook URL derived from APP_URL", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings", { headers: { cookie } });
    const body = await res.text();
    expect(body).toContain("Meta App configuration");
    expect(body).toContain("http://localhost:3000/api/oauth/facebook/callback");
    expect(body).toContain("http://localhost:3000/api/oauth/instagram/callback");
    expect(body).toContain("http://localhost:3000/api/webhooks/meta");
  });

  it("saves an alert webhook with encrypted headers and echoes header NAMES (not values)", async () => {
    if (!TEST_DB) return;
    const save = await app.request("/settings/alert-webhook", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", enabled: "true", headers: "Authorization: Bearer s3cr3t", extra: '{"to":"ops@x.com"}', selection: "type, detail" }),
    });
    expect(save.status).toBe(200);
    const html = await save.text();
    expect(html).toContain("Alert webhook saved.");
    expect(html).toContain("Authorization"); // name shown
    expect(html).not.toContain("s3cr3t"); // value never echoed

    const row = await db.query.alertWebhooks.findFirst({ where: eq(s.alertWebhooks.workspace_id, WS) });
    expect(row?.url).toBe("https://example.com/hook");
    expect(row?.custom_headers_encrypted).toBeTruthy();
    expect(row?.custom_headers_encrypted).not.toContain("s3cr3t");
    expect(row?.field_selection).toEqual(["type", "detail"]);
  });

  it("rejects invalid extra-fields JSON without saving", async () => {
    if (!TEST_DB) return;
    await db.delete(s.alertWebhooks).where(eq(s.alertWebhooks.workspace_id, WS));
    const res = await app.request("/settings/alert-webhook", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", enabled: "true", extra: "{not json" }),
    });
    expect((await res.text())).toContain("valid JSON");
    const row = await db.query.alertWebhooks.findFirst({ where: eq(s.alertWebhooks.workspace_id, WS) });
    expect(row).toBeUndefined();
  });
});

describe("channels — managed connection section", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function mockGraph() {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/me/accounts") && url.includes("instagram_business_account"))
        return Promise.resolve(Response.json({ data: [{ id: "FB9", name: "Page Nine", access_token: "PT9", instagram_business_account: { id: "IG9", name: "IG Nine", username: "ig_nine", profile_picture_url: "p" } }] }));
      if (url.includes("/me/accounts")) return Promise.resolve(Response.json({ data: [{ id: "FB9", name: "Page Nine", access_token: "PT9" }] }));
      if (url.includes("/me?")) return Promise.resolve(Response.json({ id: "MASTER9", name: "Master Nine" }));
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }) as typeof fetch;
  }

  it("renders the managed-connection section + System User guide on PRO", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/channels", { headers: { cookie } })).text();
    expect(body).toContain("Managed connection");
    expect(body).toContain("System User token"); // the guide CTA
  });

  it("shows the Meta callback / redirect URLs on /channels (not just Settings)", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/channels", { headers: { cookie } })).text();
    expect(body).toContain("callback / redirect URLs");
    expect(body).toContain("http://localhost:3000/api/oauth/facebook/callback");
    expect(body).toContain("http://localhost:3000/api/oauth/instagram/callback");
    expect(body).toContain("http://localhost:3000/api/webhooks/meta");
  });

  it("connecting a master token renders the source with its derived channels", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const res = await app.request("/channels/sources", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ token: "MASTER_TOKEN_dashboard_xxxx" }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Master Nine");
    expect(html).toContain("@ig_nine");

    const src = await db.query.accountSources.findFirst({ where: eq(s.accountSources.workspace_id, WS) });
    expect(src?.provider_account_id).toBe("MASTER9");
    const derived = await db.query.channels.findMany({ where: eq(s.channels.source_id, src!.id) });
    expect(derived).toHaveLength(2);
  });
});
