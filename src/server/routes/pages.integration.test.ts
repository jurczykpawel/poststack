import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  users, workspaces, channels, contacts, contactChannels, conversations, messages, autoReplyRules, sequences,
} from "@/db/schema";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";
import { BRAND } from "@/lib/brand";

const TEST_DB = process.env.TEST_DATABASE_URL;
const EMAIL = "hono-pages@example.test";
const PASSWORD = "supersecret123";

let db: typeof import("@/lib/db").db;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;
let app: Hono;
let cookie = "";
let workspaceId = "";

function cookieFrom(res: Response): string {
  const sc = res.headers.get("set-cookie") ?? "";
  const m = sc.match(/rs_session=[^;]+/);
  return m ? m[0] : "";
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.REGISTRATION_ENABLED = "true";
  delete process.env.ALTCHA_HMAC_KEY;
  ({ db } = await import("@/lib/db"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
  const { buildApp } = await import("../app");
  app = buildApp();
  await licenseInstance(); // form tests create interactive + follow-gate rules (PRO)

  // Clear the shared rate-limit table so the once-per-run registration isn't
  // blocked by counters left over from other suites / earlier runs.
  await db.execute(sql.raw("DELETE FROM rate_limit_counters"));
  // Drop the prior run's workspace(s) too (cascades channels) — channels are
  // globally unique per (platform, platform_id), so a leaked PAGE_PG would
  // collide on the next run if only the user were deleted.
  const prior = await db.query.users.findFirst({
    where: eq(users.email, EMAIL),
    columns: {},
    with: { workspaceMembers: { columns: { workspace_id: true } } },
  });
  for (const m of prior?.workspaceMembers ?? []) {
    await db.delete(workspaces).where(eq(workspaces.id, m.workspace_id));
  }
  await db.delete(users).where(eq(users.email, EMAIL));
  const res = await app.request("/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  expect(res.status).toBe(204);
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
  // The reply test enqueues an outgoing-message; clear the shared queue for
  // serially-following suites.
  await db.execute(sql.raw("truncate table graphile_worker._private_jobs cascade"));
  // Delete the workspace (cascades channels/conversations) so no orphan channel
  // survives to collide on the global (platform, platform_id) unique index.
  if (workspaceId) await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(users).where(eq(users.email, EMAIL));
  if (closeQueue) await closeQueue();
  await db.$client.end();
});

const withCookie = (extra: Record<string, string> = {}) => ({ cookie, ...extra });

describe("register validation errors are human-readable (real Postgres)", () => {
  it("a too-short password shows the field message, not a generic error", async () => {
    if (!TEST_DB) return;
    await db.execute(sql.raw("DELETE FROM rate_limit_counters"));
    const res = await app.request("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "shortpw@example.test", password: "short" }),
    });
    const body = await res.text();
    expect(body).toContain("at least 8 characters");
    expect(body).not.toContain("Invalid request data");
  });
});

describe("authenticated dashboard (real Postgres)", () => {
  it("register issues a working session that renders the inbox", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/inbox", { headers: withCookie() });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Select a conversation");
    expect(body).toContain(BRAND.name);
  });

  it("renders a seeded conversation and its thread, and accepts a reply", async () => {
    if (!TEST_DB) return;
    const [channel] = await db.insert(channels).values({
      workspace_id: workspaceId, platform: "facebook", platform_id: "PAGE_PG",
      display_name: "Page", token_encrypted: encryptTokens({ access_token: "tok" }),
      webhook_secret: "wh", status: "active",
    }).returning({ id: channels.id });
    const [contact] = await db.insert(contacts).values({
      workspace_id: workspaceId, display_name: "Jane Doe",
    }).returning({ id: contacts.id });
    await db.insert(contactChannels).values({
      contact_id: contact.id, channel_id: channel.id, platform_sender_id: "PSID1", platform_username: "jane",
    });
    const [conv] = await db.insert(conversations).values({
      workspace_id: workspaceId, channel_id: channel.id, contact_id: contact.id,
      platform: "facebook", status: "open", last_message_preview: "hello there", unread_count: 2,
    }).returning({ id: conversations.id });
    await db.insert(messages).values({
      conversation_id: conv.id, direction: "inbound", text: "hello there", status: "delivered",
    });

    const list = await app.request("/inbox", { headers: withCookie() });
    expect(await list.text()).toContain("Jane Doe");

    const thread = await app.request(`/inbox/${conv.id}`, { headers: withCookie() });
    expect(thread.status).toBe(200);
    expect(await thread.text()).toContain("hello there");

    // opening the thread cleared unread
    const refreshed = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id), columns: { unread_count: true } });
    expect(refreshed!.unread_count).toBe(0);

    const reply = await app.request(`/inbox/${conv.id}/reply`, {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "thanks!" }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain("Jane Doe");
  });

  it("renders channels, contacts, rules, sequences, settings", async () => {
    if (!TEST_DB) return;
    for (const [path, marker] of [
      ["/channels", "Channels"],
      ["/contacts", "Contacts"],
      ["/rules", "Rules"],
      ["/approvals", "Approvals"],
      ["/sequences", "Sequences"],
      ["/settings", "API Keys"],
    ] as const) {
      const res = await app.request(path, { headers: withCookie() });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain(marker);
    }
  });

  it("renders the quick reply + button editor on the rules page", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/rules", { headers: withCookie() })).text();
    expect(body).toContain("Quick replies");
    expect(body).toContain("name=\"quick_replies_json\"");
    expect(body).toContain("name=\"buttons_json\"");
  });

  it("creates an API key and shows the plaintext once", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings/api-keys", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      // The form always serializes the scope checkboxes; an explicit non-empty set is required
      // since deselecting them all is rejected rather than minting full access.
      body: JSON.stringify({ name: "CI key", scopes_json: JSON.stringify(["contacts:read"]) }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("rs_live_");
    expect(body).toContain("CI key");
  });

  it("creates a keyword rule from the simplified form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Greet", keywords: "hi, hello", text: "Welcome!" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Greet");
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "Greet")) });
    expect(rule?.trigger_type).toBe("keyword");
  });

  it("creates a comment rule scoped to a post with a reply mode from the form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "PostScoped", trigger_type: "comment_keyword", keywords: "info",
        post_id: "POST_42", reply_mode: "both", comment_reply_text: "DM sent!", text: "check your DMs",
      }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "PostScoped")) });
    expect(rule?.trigger_type).toBe("comment_keyword");
    expect((rule?.trigger_config as { post_id?: string }).post_id).toBe("POST_42");
    expect((rule?.response_config as { reply_mode?: string }).reply_mode).toBe("both");
    expect((rule?.response_config as { comment_reply_text?: string }).comment_reply_text).toBe("DM sent!");
  });

  it("creates a rule with quick replies and buttons from the form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "Interactive",
        keywords: "hi",
        text: "Pick one:",
        quick_replies_json: JSON.stringify([
          { content_type: "text", title: "Yes", payload: "YES" },
          { content_type: "user_email" },
        ]),
        buttons_json: JSON.stringify([{ title: "Claim", payload: "CLAIM_LM" }]),
      }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "Interactive")) });
    const rc = rule?.response_config as { quick_replies?: unknown[]; buttons?: Array<{ title: string; payload?: string }> };
    expect(rc.quick_replies).toHaveLength(2);
    expect(rc.buttons?.[0]).toEqual({ title: "Claim", payload: "CLAIM_LM" });
  });

  it("creates a rule with requires_approval from the form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Gated", keywords: "review", text: "needs review", requires_approval: "true" }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "Gated")) });
    expect(rule?.requires_approval).toBe(true);
  });

  it("creates a follow_gate postback rule from the form", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "FollowGate", trigger_type: "postback", payload: "CLAIM_LM", response_mode: "follow_gate",
        followed_text: "Here is your guide", not_followed_text: "Follow first 🙏", claim_label: "Chcę odebrać",
      }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "FollowGate")) });
    expect(rule?.response_type).toBe("follow_gate");
    expect(rule?.trigger_type).toBe("postback");
    expect((rule?.trigger_config as { payload?: string }).payload).toBe("CLAIM_LM");
    const rc = rule?.response_config as { followed: { text: string }; not_followed: { text: string; buttons: Array<{ payload: string }> } };
    expect(rc.followed.text).toBe("Here is your guide");
    expect(rc.not_followed.buttons[0].payload).toBe("CLAIM_LM");
  });

  it("connects a Telegram bot from the channels form (getMe + setWebhook)", async () => {
    if (!TEST_DB) return;
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 987654, is_bot: true, first_name: "ReplyBot", username: "reply_bot" } });
      if (url.endsWith("/setWebhook")) return Response.json({ ok: true, result: true });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const res = await app.request("/channels/telegram/connect", {
        method: "POST",
        headers: withCookie({ "content-type": "application/json" }),
        body: JSON.stringify({ token: "987654321:AAExampleBotTokenValue1234567890" }),
      });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen.some((u) => u.endsWith("/setWebhook"))).toBe(true);
    const ch = await db.query.channels.findFirst({ where: and(eq(channels.workspace_id, workspaceId), eq(channels.platform, "telegram")) });
    expect(ch?.platform_id).toBe("987654");
    expect(ch?.username).toBe("reply_bot");
  });

  it("marks the channel unhealthy when Telegram webhook registration fails", async () => {
    if (!TEST_DB) return;
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 111222, is_bot: true, first_name: "BrokenBot", username: "broken_bot" } });
      if (url.endsWith("/setWebhook")) return Response.json({ ok: false, description: "bad url" }, { status: 400 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    let bodyText = "";
    try {
      const res = await app.request("/channels/telegram/connect", {
        method: "POST",
        headers: withCookie({ "content-type": "application/json" }),
        body: JSON.stringify({ token: "111222333:AAExampleBotTokenValue1234567890" }),
      });
      expect(res.status).toBe(200); // dashboard wraps the error as an htmx fragment
      bodyText = await res.text();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodyText.toLowerCase()).toContain("webhook");
    const ch = await db.query.channels.findFirst({ where: and(eq(channels.workspace_id, workspaceId), eq(channels.platform_id, "111222")) });
    expect(ch?.status).toBe("needs_reauth"); // not reported as healthy/active
  });

  it("rejects an invalid Telegram token shape (no channel created)", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/channels/telegram/connect", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(200); // dashboard wraps the 422 into an htmx error fragment
    const bots = await db.select().from(channels).where(and(eq(channels.workspace_id, workspaceId), eq(channels.platform, "telegram")));
    expect(bots.every((b) => b.platform_id !== "not-a-real-token")).toBe(true);
  });

  it("renders the approvals review page", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/approvals", { headers: withCookie() })).text();
    expect(body).toContain("Approvals");
    expect(body).toContain("Nothing waiting for approval");
  });

  it("ignores empty interactive JSON without erroring", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/rules", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Plain", keywords: "yo", text: "hello", quick_replies_json: "[]", buttons_json: "" }),
    });
    expect(res.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: and(eq(autoReplyRules.workspace_id, workspaceId), eq(autoReplyRules.name, "Plain")) });
    const rc = rule?.response_config as Record<string, unknown>;
    expect(rc.quick_replies).toBeUndefined();
    expect(rc.buttons).toBeUndefined();
  });

  it("creates a sequence from line-based steps", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/sequences", {
      method: "POST",
      headers: withCookie({ "content-type": "application/json" }),
      body: JSON.stringify({ name: "Onboarding", steps: "Hi\nDay two tip" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Onboarding");
    const seq = await db.query.sequences.findFirst({ where: and(eq(sequences.workspace_id, workspaceId), eq(sequences.name, "Onboarding")) });
    expect(Array.isArray(seq?.steps) ? (seq!.steps as unknown[]).length : 0).toBe(2);
  });
});
