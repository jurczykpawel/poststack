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
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
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

  it("scopes a rule to one channel on create and clears it on edit", async () => {
    if (!TEST_DB) return;
    // A real channel id (the API validates channel_id as a strict v4 UUID, like gen_random_uuid).
    const SCOPED_CH = "dddddddd-0000-4000-8000-000000005c01";
    await db.insert(s.channels).values({ id: SCOPED_CH, workspace_id: WS, platform: "youtube", platform_id: "YT-SCOPE", display_name: "My channel", token_encrypted: "x", webhook_secret: "ssc", status: "active" });

    const created = await app.request("/rules", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "ScopedRule", trigger_type: "comment_keyword", keywords: "info", text: "hello", channel_id: SCOPED_CH }),
    });
    expect(created.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.name, "ScopedRule") });
    expect(rule!.channel_id).toBe(SCOPED_CH);
    // The list shows the channel scope, not "All channels".
    expect(await created.text()).toContain("My channel");

    // Editing with an empty channel clears the scope back to all channels.
    const edited = await app.request(`/rules/${rule!.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "ScopedRule", keywords: "info", text: "hello", channel_id: "" }),
    });
    expect(edited.status).toBe(200);
    const after = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, rule!.id) });
    expect(after!.channel_id).toBeNull();
  });

  it("edit form shows and lets you change a rule's action buttons (link in DM)", async () => {
    if (!TEST_DB) return;
    const [seeded] = await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "LM rule", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
      response_type: "text",
      response_config: {
        text: "Here you go!", reply_mode: "both",
        buttons: [{ title: "Get the kit", url: "https://sellf.example/p/kit" }],
        quick_replies: [{ content_type: "user_email" }],
      },
    }).returning({ id: s.autoReplyRules.id });

    // The edit form pre-fills the existing button (not an opaque "kept as-is" note).
    const editForm = await (await app.request(`/rules/${seeded!.id}/edit`, { headers: { cookie } })).text();
    expect(editForm).toContain("https://sellf.example/p/kit");
    expect(editForm).toContain("user_email");
    expect(editForm).not.toContain("kept as-is");

    // Saving a changed button replaces it in the stored config.
    const res = await app.request(`/rules/${seeded!.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "LM rule", keywords: "info", text: "Here you go!", reply_mode: "both",
        buttons_json: JSON.stringify([{ title: "Pobierz", url: "https://sellf.example/p/v2" }]),
        quick_replies_json: JSON.stringify([{ content_type: "user_phone_number" }]),
      }),
    });
    expect(res.status).toBe(200);
    const after = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, seeded!.id) });
    const rc = after!.response_config as Record<string, unknown>;
    expect(rc.buttons).toEqual([{ title: "Pobierz", url: "https://sellf.example/p/v2" }]);
    expect(rc.quick_replies).toEqual([{ content_type: "user_phone_number" }]);
  });

  it("AI rephrase toggle: create sets response_config.ai_rephrase, edit can turn it off", async () => {
    if (!TEST_DB) return;
    // Licensed instance (licenseInstance in beforeAll) → the create form renders the rephrase toggle.
    const form = await (await app.request("/rules", { headers: { cookie } })).text();
    expect(form).toContain("Rephrase with AI for variety");

    const created = await app.request("/rules", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rephrased", trigger_type: "keyword", keywords: "hi", text: "hello", ai_rephrase: "true" }),
    });
    expect(created.status).toBe(200);
    const rule = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.name, "Rephrased") });
    expect((rule!.response_config as Record<string, unknown>).ai_rephrase).toBe(true);
    // The list summary flags it.
    expect(await (await app.request("/rules", { headers: { cookie } })).text()).toContain("AI rephrase");

    // Editing with the toggle off removes the flag.
    const edited = await app.request(`/rules/${rule!.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Rephrased", keywords: "hi", text: "hello", ai_rephrase: "false" }),
    });
    expect(edited.status).toBe(200);
    const after = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, rule!.id) });
    expect((after!.response_config as Record<string, unknown>).ai_rephrase).toBeUndefined();
  });

  it("rules list shows what each rule does — keywords, reply text and button link", async () => {
    if (!TEST_DB) return;
    await db.insert(s.autoReplyRules).values({
      workspace_id: WS, name: "Summary rule", trigger_type: "comment_keyword", is_active: true, cooldown_seconds: 0,
      trigger_config: { keywords: [{ value: "promo", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "Grab the deal here", reply_mode: "both", buttons: [{ title: "Open", url: "https://sellf.example/p/deal" }] },
    });
    const body = await (await app.request("/rules", { headers: { cookie } })).text();
    expect(body).toContain("promo"); // keyword
    expect(body).toContain("Grab the deal here"); // reply text preview
    expect(body).toContain("https://sellf.example/p/deal"); // button link
  });
});

describe("channel detail page", () => {
  it("links to the channel's inbox and shows PRO stats", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request(`/channels/${CH}`, { headers: { cookie } })).text();
    expect(body).toContain(`/inbox?channel=${CH}`); // inbox filtered to this channel
    expect(body).toContain("View inbox");
    expect(body).toContain("Stats"); // PRO stats panel (license fixture = PRO)
    expect(body).toContain("Posts published");
    expect(body).not.toContain("Channel stats (posts &amp; messages) are a PRO feature");
  });
});

describe("dashboard events feed", () => {
  it("shows the event with a friendly label, platform and subject name", async () => {
    if (!TEST_DB) return;
    await db.insert(s.events).values({
      workspace_id: WS, type: "channel.needs_reauth", subject_type: "channel", subject_id: CH,
      payload: { platform: "instagram", displayName: "Acme IG" },
    });
    const body = await (await app.request("/events", { headers: { cookie } })).text();
    expect(body).toContain("Channel needs re-auth"); // friendly label, not the raw type
    expect(body).toContain("Instagram"); // platform column
    expect(body).toContain("Acme IG"); // subject name from payload
    expect(body).not.toContain("No events yet");
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
    expect(await res.text()).toContain("Resume auto-reply");
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

  it("shows the Meta 24h-window heads-up in the composer when the window has closed", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ last_inbound_at: new Date(Date.now() - 48 * 60 * 60 * 1000) }).where(eq(s.conversations.id, CONV));
    const body = await (await app.request(`/inbox/${CONV}`, { headers: { cookie } })).text();
    expect(body).toContain("human-agent");
  });

  it("shows no window heads-up while the conversation is well within the 24h window", async () => {
    if (!TEST_DB) return;
    await db.update(s.conversations).set({ last_inbound_at: new Date() }).where(eq(s.conversations.id, CONV));
    const body = await (await app.request(`/inbox/${CONV}`, { headers: { cookie } })).text();
    expect(body).not.toContain("human-agent");
    expect(body).not.toContain("window closes in");
  });

  it("renders a comment in its thread (not 'No messages yet') with post + auto-DM status", async () => {
    if (!TEST_DB) return;
    const COMMENT_CONV = "dddddddd-0000-0000-0000-0000000000c1";
    await db.insert(s.conversations).values({
      id: COMMENT_CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook",
      thread_type: "comment", thread_ref: "POST-42",
    });
    await db.insert(s.commentLogs).values({
      channel_id: CH, workspace_id: WS, conversation_id: COMMENT_CONV, post_id: "POST-42",
      platform_comment_id: "cmt-1", author_id: "PSID-D", author_name: "rin", comment_text: "😂😂",
      dm_sent: true, reply_sent: true, reply_text: "Thanks for commenting!",
    });
    // the contact's DM thread already exists (the beforeEach-seeded CONV) → the comment item links to it
    const res = await app.request(`/inbox/${COMMENT_CONV}`, { headers: { cookie } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("😂😂");
    expect(body).toContain("commented");
    expect(body).toContain("POST-42");
    expect(body).toContain("Thanks for commenting!"); // the actual public reply text
    expect(body).toContain("auto-DM sent");
    expect(body).toContain("open DM thread"); // link to the separate DM thread
    // FB post link (postId → facebook.com)
    expect(body).toContain("facebook.com/POST-42");
    expect(body).not.toContain("No messages yet");
  });

  it("links an Instagram comment to its stored permalink (media id has no constructable URL)", async () => {
    if (!TEST_DB) return;
    const IG_CH = "dddddddd-0000-0000-0000-0000000000e1";
    const IG_CONTACT = "dddddddd-0000-0000-0000-0000000000e2";
    const IG_CONV = "dddddddd-0000-0000-0000-0000000000e3";
    await db.insert(s.channels).values({ id: IG_CH, workspace_id: WS, platform: "instagram", platform_id: "IG-PERMA", display_name: "IG", token_encrypted: "x", webhook_secret: "se1", status: "active" });
    await db.insert(s.contacts).values({ id: IG_CONTACT, workspace_id: WS, display_name: "Iga" });
    await db.insert(s.conversations).values({
      id: IG_CONV, workspace_id: WS, channel_id: IG_CH, contact_id: IG_CONTACT, platform: "instagram",
      thread_type: "comment", thread_ref: "18115367134699712",
    });
    await db.insert(s.commentLogs).values({
      channel_id: IG_CH, workspace_id: WS, conversation_id: IG_CONV, post_id: "18115367134699712",
      post_url: "https://www.instagram.com/reel/DYuqTvIFHO2/",
      platform_comment_id: "ig-cmt-1", author_id: "IG-SENDER", author_name: "iga", comment_text: "love this",
    });
    const body = await (await app.request(`/inbox/${IG_CONV}`, { headers: { cookie } })).text();
    expect(body).toContain("love this");
    expect(body).toContain("https://www.instagram.com/reel/DYuqTvIFHO2/"); // clickable permalink
  });

  it("links a contact to its conversations and the inbox filters by contact", async () => {
    if (!TEST_DB) return;
    // CONTACT (seeded) owns CONV on CH. A second contact with no conversation.
    const OTHER = "dddddddd-0000-4000-8000-0000000000cc";
    await db.insert(s.contacts).values({ id: OTHER, workspace_id: WS, display_name: "No Threads Person" });

    const list = await (await app.request("/contacts/list", { headers: { cookie } })).text();
    expect(list).toContain(`/inbox?contact=${CONTACT}`); // per-contact inbox deep-link

    // Inbox filtered to CONTACT shows their conversation; filtered to OTHER shows none.
    const forContact = await (await app.request(`/inbox?contact=${CONTACT}`, { headers: { cookie } })).text();
    expect(forContact).not.toContain("No conversations"); // CONTACT has CONV
    const forOther = await (await app.request(`/inbox?contact=${OTHER}`, { headers: { cookie } })).text();
    // OTHER has no conversation → the conv list is empty (no conversation rows for OTHER).
    expect(forOther).not.toContain(`hx-get="/inbox/${CONV}"`);
  });

  it("contacts view filters by channel + platform (auto-assignment)", async () => {
    if (!TEST_DB) return;
    const CH3 = "dddddddd-0000-0000-0000-0000000000d1";
    const CONTACT3 = "dddddddd-0000-0000-0000-0000000000d2";
    await db.insert(s.channels).values({ id: CH3, workspace_id: WS, platform: "instagram", platform_id: "IG-CT", display_name: "IG Shop", token_encrypted: "x", webhook_secret: "s3", status: "active" });
    await db.insert(s.contacts).values({ id: CONTACT3, workspace_id: WS, display_name: "IG Only Person" });
    await db.insert(s.contactChannels).values({ contact_id: CONTACT3, channel_id: CH3, platform_sender_id: "IGSENDER", platform_username: "ig_only" });

    // page shows the channel + platform filter dropdowns (now that there are 2 channels / platforms)
    const page = await (await app.request("/contacts", { headers: { cookie } })).text();
    expect(page).toContain("All channels");
    expect(page).toContain("All platforms");
    expect(page).toContain("IG Shop");

    // channel filter → only the IG contact
    const byChannel = await (await app.request(`/contacts/list?channel=${CH3}`, { headers: { cookie } })).text();
    expect(byChannel).toContain("IG Only Person");
    expect(byChannel).not.toContain("dylankelly"); // (the FB-seeded CONTACT has no such name; just ensure scoping)

    // platform filter → instagram only
    const byPlatform = await (await app.request("/contacts/list?platform=instagram", { headers: { cookie } })).text();
    expect(byPlatform).toContain("IG Only Person");
    expect(byPlatform).toContain("@ig_only"); // handle shown
  });

  it("offers a channel filter dropdown and filters by channel", async () => {
    if (!TEST_DB) return;
    // a second channel so the dropdown renders (>1 channel)
    const CH2 = "dddddddd-0000-0000-0000-0000000000c8";
    await db.insert(s.channels).values({ id: CH2, workspace_id: WS, platform: "instagram", platform_id: "IG-D2", display_name: "Second IG", token_encrypted: "x", webhook_secret: "s2", status: "active" });
    await db.insert(s.conversations).values({ id: "dddddddd-0000-0000-0000-0000000000c9", workspace_id: WS, channel_id: CH2, contact_id: CONTACT, platform: "instagram", thread_type: "dm", thread_ref: "ig", last_message_preview: "from second channel" });
    const page = await (await app.request("/inbox", { headers: { cookie } })).text();
    expect(page).toContain("All channels");
    expect(page).toContain("Second IG");
    // filter to CH2 only → the CH (default CONV) conversation is excluded
    const filtered = await (await app.request(`/inbox/list?filter=all&channel=${CH2}`, { headers: { cookie } })).text();
    expect(filtered).toContain("from second channel");
  });

  it("filters the inbox list by comment vs dm threads", async () => {
    if (!TEST_DB) return;
    const COMMENT_CONV = "dddddddd-0000-0000-0000-0000000000c2";
    await db.insert(s.conversations).values({
      id: COMMENT_CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT, platform: "facebook",
      thread_type: "comment", thread_ref: "POST-99", last_message_preview: "a comment preview",
    });
    const comments = await (await app.request("/inbox/list?filter=comment", { headers: { cookie } })).text();
    expect(comments).toContain("a comment preview");
    const dms = await (await app.request("/inbox/list?filter=dm", { headers: { cookie } })).text();
    expect(dms).not.toContain("a comment preview"); // the DM filter excludes the comment thread
  });

  it("control bar has a self-explanatory legend + clear labels", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request(`/inbox/${CONV}`, { headers: { cookie } })).text();
    expect(body).toContain("what do these mean?");
    expect(body).toContain("Pause auto-reply");
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
    expect(body).toContain("http://localhost:3000/api/oauth/youtube/callback"); // YouTube redirect URI
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

  it("the unified channels page links to the managed-connection section + offers connect buttons", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/channels", { headers: { cookie } })).text();
    // Managed connection moved to its own /sources section (UNIFY1 Task 5); the channels page links to it.
    expect(body).toContain('href="/sources"');
    expect(body).toContain("+ Facebook");
    expect(body).toContain("+ Instagram");
    expect(body).toContain("Connect a token manually");
  });

  it("edits a rule's name + reply text via the edit form, preserving advanced config", async () => {
    if (!TEST_DB) return;
    const RID = "dddddddd-0000-0000-0000-0000000000e1";
    await db.insert(s.autoReplyRules).values({
      id: RID, workspace_id: WS, name: "Greeter", trigger_type: "keyword",
      trigger_config: { keywords: [{ value: "hi", match_type: "contains" }] },
      response_type: "text",
      response_config: { text: "old reply", buttons: [{ title: "Visit", url: "https://example.com" }] },
    });
    // The edit form is prefilled
    const form = await (await app.request(`/rules/${RID}/edit`, { headers: { cookie } })).text();
    expect(form).toContain('value="Greeter"');
    expect(form).toContain("old reply");
    // Saving updates name + text + approval, and keeps the buttons we didn't touch
    const res = await app.request(`/rules/${RID}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Greeter v2", keywords: "hi, hello", text: "new reply", requires_approval: "true" }),
    });
    expect(res.status).toBe(200);
    const updated = await db.query.autoReplyRules.findFirst({ where: eq(s.autoReplyRules.id, RID) });
    expect(updated?.name).toBe("Greeter v2");
    expect((updated?.response_config as { text: string }).text).toBe("new reply");
    expect((updated?.response_config as { buttons: unknown[] }).buttons).toHaveLength(1); // preserved
    expect((updated?.trigger_config as { keywords: unknown[] }).keywords).toHaveLength(2);
    expect(updated?.requires_approval).toBe(true);
  });

  it("engagement shows the owning page name + a post link, not just the raw id", async () => {
    if (!TEST_DB) return;
    const PCH = "dddddddd-0000-0000-0000-0000000000a8";
    await db.insert(s.channels).values({ id: PCH, workspace_id: WS, platform: "facebook", platform_id: "PAGE1", display_name: "My FB Page", token_encrypted: "x", webhook_secret: "pp", status: "active" });
    await db.insert(s.postReactions).values({ workspace_id: WS, channel_id: PCH, post_id: "PAGE1_999", reactor_id: "r1", reactor_name: "Reactor One", reaction_type: "like" });
    const body = await (await app.request("/engagement", { headers: { cookie } })).text();
    expect(body).toContain("My FB Page");
    expect(body).toContain("View post");
    expect(body).toContain("Reactor One");
  });

  it("webhooks page separates incoming vs outgoing and explains the statuses", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/webhooks", { headers: { cookie } })).text();
    expect(body).toContain("Incoming");
    expect(body).toContain("Outgoing");
    expect(body).toContain("What do the statuses mean?");
    expect(body).toContain("Matched an active rule"); // a legend entry
    expect(body).toContain("Stored for engagement only"); // the 'recorded' legend entry
  });

  it("shows PRO webhook delivery stats (outcome counts)", async () => {
    if (!TEST_DB) return;
    await db.insert(s.webhookEvents).values([
      { event_key: "st-1", channel_id: CH, event_type: "post_reaction", raw: {}, handling_status: "recorded" },
      { event_key: "st-2", channel_id: CH, event_type: "message", raw: {}, handling_status: "error", error_detail: "boom" },
    ]);
    const body = await (await app.request("/webhooks", { headers: { cookie } })).text();
    expect(body).toContain("Total received");
    expect(body).toContain("Engagement (likes/reactions)");
    expect(body).toContain("Errors");
  });

  it("webhooks detail shows the raw payload + what was triggered", async () => {
    if (!TEST_DB) return;
    const EV = "dddddddd-0000-0000-0000-0000000000e9";
    await db.insert(s.webhookEvents).values({
      id: EV, event_key: "k-detail-1", channel_id: CH, object: "page", event_type: "post_reaction", field: "feed",
      sender_id: "SENDER-1",
      raw: { entry: [{ changes: [{ value: { from: { id: "SENDER-1", name: "Noémie Pfirsch" }, item: "reaction" } }] }] },
      handling_status: "recorded",
    });
    const body = await (await app.request(`/webhooks/${EV}`, { headers: { cookie } })).text();
    expect(body).toContain("Raw payload");
    expect(body).toContain("Noémie Pfirsch"); // name resolved from the payload, not the bare id
    expect(body).toContain("engagement only"); // recorded → nothing triggered
  });

  it("webhooks detail is tenant-scoped — another workspace's event is not found", async () => {
    if (!TEST_DB) return;
    const WSX = "dddddddd-0000-0000-0000-0000000000f7";
    const CHX = "dddddddd-0000-0000-0000-0000000000f8";
    const EVX = "dddddddd-0000-0000-0000-0000000000f9";
    await db.insert(s.workspaces).values({ id: WSX, name: "X", slug: `x-${WSX}` });
    await db.insert(s.channels).values({ id: CHX, workspace_id: WSX, platform: "facebook", platform_id: "FB-X", token_encrypted: "x", webhook_secret: "wx", status: "active" });
    await db.insert(s.webhookEvents).values({ id: EVX, event_key: "k-x", channel_id: CHX, event_type: "message", raw: {}, handling_status: "fired" });
    const res = await app.request(`/webhooks/${EVX}`, { headers: { cookie } });
    expect((await res.text())).toContain("not found");
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WSX));
  });

  it("filters contacts by brand", async () => {
    if (!TEST_DB) return;
    await db.insert(s.brands).values([
      { workspace_id: WS, key: "acme", name: "Acme" },
      { workspace_id: WS, key: "globex", name: "Globex" },
    ]);
    const chA = "dddddddd-0000-0000-0000-0000000000b1";
    const chB = "dddddddd-0000-0000-0000-0000000000b2";
    await db.insert(s.channels).values([
      { id: chA, workspace_id: WS, platform: "instagram", platform_id: "IG-A", token_encrypted: "x", webhook_secret: "ba", status: "active", brand_key: "acme" },
      { id: chB, workspace_id: WS, platform: "instagram", platform_id: "IG-B", token_encrypted: "x", webhook_secret: "bb", status: "active", brand_key: "globex" },
    ]);
    const ctA = "dddddddd-0000-0000-0000-0000000000c1";
    const ctB = "dddddddd-0000-0000-0000-0000000000c2";
    await db.insert(s.contacts).values([
      { id: ctA, workspace_id: WS, display_name: "AliceAcme" },
      { id: ctB, workspace_id: WS, display_name: "BobGlobex" },
    ]);
    await db.insert(s.contactChannels).values([
      { contact_id: ctA, channel_id: chA, platform_sender_id: "sa" },
      { contact_id: ctB, channel_id: chB, platform_sender_id: "sb" },
    ]);
    const body = await (await app.request("/contacts/list?brand=acme", { headers: { cookie } })).text();
    expect(body).toContain("AliceAcme");
    expect(body).not.toContain("BobGlobex");
  });

  it("the contacts page shows a brand filter when brands exist", async () => {
    if (!TEST_DB) return;
    await db.insert(s.brands).values([
      { workspace_id: WS, key: "acme", name: "Acme" },
      { workspace_id: WS, key: "globex", name: "Globex" },
    ]);
    const body = await (await app.request("/contacts", { headers: { cookie } })).text();
    expect(body).toContain('name="brand"');
    expect(body).toContain("Acme");
  });

  it("/api-keys redirects to the Settings API keys tab", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api-keys", { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings#apikeys");
  });

  it("Settings → API keys tab embeds the create form + key list", async () => {
    if (!TEST_DB) return;
    const body = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(body).toContain('hx-post="/settings/api-keys"'); // the create form lives in Settings now
    expect(body).toContain('id="keys-area"');
    expect(body).not.toContain('href="/api-keys"'); // no longer a link-out
  });

  it("renders the @handle + avatar from the username/profile_picture columns (not metadata)", async () => {
    if (!TEST_DB) return;
    const CHH = "dddddddd-0000-0000-0000-0000000000f1";
    await db.insert(s.channels).values({
      id: CHH, workspace_id: WS, platform: "instagram", platform_id: "IG-HANDLE",
      display_name: "Handle Shop", username: "shop_handle", profile_picture: "https://example.com/pic.jpg",
      token_encrypted: "x", webhook_secret: "sh", status: "active", metadata: {},
    });
    const body = await (await app.request("/channels", { headers: { cookie } })).text();
    expect(body).toContain("@shop_handle");
    expect(body).toContain("https://example.com/pic.jpg");
  });

  it("the Settings → Sources tab renders the managed-connection form + System User guide on PRO", async () => {
    if (!TEST_DB) return;
    // Managed connections moved into Settings → Sources (the tab is rendered in the settings HTML).
    const body = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(body).toContain("Sources — managed connections");
    expect(body).toContain("Connect all"); // the master-token form
    expect(body).toContain("System User"); // the guide CTA
    // The Meta callback / redirect URLs live in Settings → Integrations.
    expect(body).toContain("http://localhost:3000/api/oauth/facebook/callback");
    expect(body).toContain("http://localhost:3000/api/webhooks/meta");
  });

  it("Settings → Sources groups a master source's channels by platform with per-platform counts", async () => {
    if (!TEST_DB) return;
    const SRC = "dddddddd-0000-0000-0000-0000000000d1";
    await db.insert(s.accountSources).values({
      id: SRC, workspace_id: WS, provider: "meta", provider_account_id: "MASTER_G", display_name: "Big Master",
      kind: "system_user", token_encrypted: "x", status: "active",
    });
    await db.insert(s.channels).values([
      { workspace_id: WS, source_id: SRC, platform: "instagram", platform_id: "IG-G1", display_name: "IG One", token_encrypted: "x", webhook_secret: "g1", status: "active", connection_mode: "derived" },
      { workspace_id: WS, source_id: SRC, platform: "instagram", platform_id: "IG-G2", display_name: "IG Two", token_encrypted: "x", webhook_secret: "g2", status: "active", connection_mode: "derived" },
      { workspace_id: WS, source_id: SRC, platform: "facebook", platform_id: "FB-G1", display_name: "FB One", token_encrypted: "x", webhook_secret: "g3", status: "active", connection_mode: "derived" },
    ]);
    const body = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(body).toContain("Big Master");
    expect(body).toContain("<details"); // collapsible platform groups
    expect(body).toContain("Instagram <span class=\"muted\" style=\"font-weight:400\">· 2");
    expect(body).toContain("Facebook <span class=\"muted\" style=\"font-weight:400\">· 1");
    expect(body).toContain("3 channels across 2 platforms");
  });

  it("connecting a master token via /sources renders the source with its derived channels", async () => {
    if (!TEST_DB) return;
    mockGraph();
    const res = await app.request("/sources", {
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

  // ── ENGAGE2: webhooks channel column + engagement accurate totals + brand/account filter ────────
  it("/inbox/:id renders the FULL page on a direct navigation, the bare thread for htmx", async () => {
    if (!TEST_DB) return;
    // Direct navigation (e.g. the deep-link from a webhook event) → full inbox page with chrome.
    const full = await (await app.request(`/inbox/${CONV}`, { headers: { cookie } })).text();
    expect(full).toContain('id="conv-panel"'); // full inbox layout present (not just the fragment)
    expect(full).toContain("Type a reply"); // the thread is rendered inside it

    // htmx swap → just the thread fragment, no page chrome.
    const partial = await (await app.request(`/inbox/${CONV}`, { headers: { cookie, "hx-request": "true" } })).text();
    expect(partial).not.toContain('id="conv-panel"');
    expect(partial).toContain("Type a reply");
  });

  it("/webhooks/subscriptions renders the per-account subscription panel", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ display_name: "Acme Page" }).where(eq(s.channels.id, CH));
    const res = await app.request("/webhooks/subscriptions", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Acme Page"); // the FB channel appears in the panel
    expect(body).toContain("Missing"); // header / status column present
    // The seeded channel's token can't be decrypted (token_encrypted='x') → graceful error row, no Graph call.
  });

  it("/webhooks shows which connected account each event belongs to", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ display_name: "Acme Page" }).where(eq(s.channels.id, CH));
    await db.insert(s.webhookEvents).values({
      event_key: `wh-${Date.now()}`,
      channel_id: CH,
      platform: "facebook",
      event_type: "post_reaction",
      field: "feed",
      handling_status: "recorded",
      raw: {},
    });
    const body = await (await app.request("/webhooks", { headers: { cookie } })).text();
    expect(body).toContain("<th>Channel</th>");
    expect(body).toContain("Acme Page");
  });

  it("/engagement totals reflect EVERY reaction, not a capped sample (the >1000 undercount bug)", async () => {
    if (!TEST_DB) return;
    const N = 1200;
    await db.insert(s.postReactions).values(
      Array.from({ length: N }, (_, i) => ({
        workspace_id: WS,
        channel_id: CH,
        post_id: "PG-D_bigpost",
        reactor_id: `r${i}`,
        reactor_name: `User ${i}`,
        reaction_type: "like",
      })),
    );
    const body = await (await app.request("/engagement", { headers: { cookie } })).text();
    // Old code fetched only the latest 1000 raw rows before grouping → total would cap at 1000.
    expect(body).toContain("<strong>1200</strong>");
  });

  it("/engagement filters post reactions by account and by brand", async () => {
    if (!TEST_DB) return;
    const CH2 = "dddddddd-0000-0000-0000-0000000000b9";
    await db.insert(s.brands).values([
      { workspace_id: WS, key: "acme", name: "Acme" },
      { workspace_id: WS, key: "globex", name: "Globex" },
    ]);
    await db.update(s.channels).set({ brand_key: "acme" }).where(eq(s.channels.id, CH));
    await db.insert(s.channels).values({ id: CH2, workspace_id: WS, platform: "facebook", platform_id: "PG-E", display_name: "Globex Page", brand_key: "globex", token_encrypted: "x", webhook_secret: "s2", status: "active" });
    await db.insert(s.postReactions).values([
      { workspace_id: WS, channel_id: CH, post_id: "PG-D_acmepost", reactor_id: "a1", reaction_type: "like" },
      { workspace_id: WS, channel_id: CH2, post_id: "PG-E_globexpost", reactor_id: "g1", reaction_type: "love" },
    ]);

    const all = await (await app.request("/engagement", { headers: { cookie } })).text();
    expect(all).toContain("PG-D_acmepost");
    expect(all).toContain("PG-E_globexpost");

    const byAccount = await (await app.request(`/engagement?channel=${CH2}`, { headers: { cookie } })).text();
    expect(byAccount).toContain("PG-E_globexpost");
    expect(byAccount).not.toContain("PG-D_acmepost");

    const byBrand = await (await app.request("/engagement?brand=acme", { headers: { cookie } })).text();
    expect(byBrand).toContain("PG-D_acmepost");
    expect(byBrand).not.toContain("PG-E_globexpost");
  });
});
