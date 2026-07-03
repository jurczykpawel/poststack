import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "1ace0000-0000-0000-0000-0000000000a1";
const USER = "1ace0000-0000-0000-0000-0000000000a2";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

const get = (path: string) => app.request(path, { headers: { cookie } });

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
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "UI", slug: `ui-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

describe("license-aware dashboard UI", () => {
  it("free /rules locks follow-gate, interactive, and personalization", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/rules")).text();
    expect(body).toContain("🔒 Follow-gate (PRO)");
    expect(body).toContain("Buttons &amp; quick replies are a PRO feature");
    expect(body).toContain("Personalization");
    expect(body).not.toContain("+ quick reply"); // editor hidden
  });

  it("licensed /rules shows the interactive editors and an enabled follow-gate", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const body = await (await get("/rules")).text();
    expect(body).toContain("+ quick reply");
    expect(body).toContain("+ button");
    expect(body).not.toContain("🔒 Follow-gate (PRO)");
  });

  it("free /sequences locks the builder", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/sequences")).text();
    // Full-page PRO lock (consistent with inbox/contacts), not just a hidden builder form.
    expect(body).toContain("Automated drip message sequences are a PRO feature");
    expect(body).not.toContain("Create sequence");
    expect(body).not.toContain("+ New sequence");
  });

  it("licensed /sequences shows the builder", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const body = await (await get("/sequences")).text();
    expect(body).toContain("Create sequence");
  });

  it("free /channels locks Telegram and Gmail (PRO)", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/channels")).text();
    expect(body).toContain("Telegram (PRO)");
    expect(body).toContain("Gmail (PRO)");
    expect(body).not.toContain("@click=\"tg = !tg\""); // telegram connect toggle hidden
  });

  it("free /channels locks a 2nd Facebook once one is connected", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      workspace_id: WS, platform: "facebook", platform_id: "FB-UI", token_encrypted: "x", webhook_secret: "s", status: "active",
    });
    const body = await (await get("/channels")).text();
    expect(body).toContain("Facebook (PRO)");
    expect(body).toContain("one Facebook + one Instagram channel");
  });

  it("licensed /channels unlocks Telegram", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const body = await (await get("/channels")).text();
    expect(body).toContain("@click=\"tg = !tg\"");
    expect(body).not.toContain("Telegram (PRO)");
  });

  it("licensed /channels shows a direct-OAuth connect button for a CONFIGURED generic provider (LinkedIn)", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const prevId = process.env.LINKEDIN_CLIENT_ID;
    const prevSecret = process.env.LINKEDIN_CLIENT_SECRET;
    process.env.LINKEDIN_CLIENT_ID = "test-li-id";
    process.env.LINKEDIN_CLIENT_SECRET = "test-li-secret";
    try {
      const body = await (await get("/channels")).text();
      expect(body).toContain("/api/oauth/connect/linkedin");
      expect(body).toContain("+ LinkedIn");
    } finally {
      if (prevId === undefined) delete process.env.LINKEDIN_CLIENT_ID;
      else process.env.LINKEDIN_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.LINKEDIN_CLIENT_SECRET;
      else process.env.LINKEDIN_CLIENT_SECRET = prevSecret;
    }
  });

  it("licensed /channels hides the connect button for an UNCONFIGURED generic provider (no dead button)", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const prevId = process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_KEY;
    try {
      const body = await (await get("/channels")).text();
      expect(body).not.toContain("/api/oauth/connect/tiktok");
    } finally {
      if (prevId !== undefined) process.env.TIKTOK_CLIENT_KEY = prevId;
    }
  });

  it("free /overview: inbox is free (real nav link), contacts CRM stays locked", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/overview")).text();
    expect(body).toContain("Overview");
    expect(body).toContain("Sent today");
    // Contacts CRM (+ other PRO items) still locked.
    expect(body).toContain("nav-locked");
    expect(body).toContain("<span>Contacts</span>");
    // Inbox READING is free now → a real nav link to /inbox, not an upgrade lock.
    expect(body).toContain('href="/inbox"');
    // Overview hint reflects the new model: replying BY HAND is PRO, not the whole inbox.
    expect(body).toContain("Replying to conversations by hand is");
    expect(body).not.toContain("Open individual conversations with");
  });

  it("free /inbox renders the conversation list (free); only the reply box is PRO", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/inbox")).text();
    expect(body).not.toContain("The conversation inbox is a PRO feature"); // page no longer locked
    expect(body).toContain("Select a conversation"); // the real inbox renders for free
  });

  it("free /contacts is locked behind PRO", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/contacts")).text();
    expect(body).toContain("The contacts CRM is a PRO feature");
    expect(body).not.toContain("Search by name, email, username");
  });

  it("licensed /inbox renders the real inbox and unlocks the nav", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const body = await (await get("/inbox")).text();
    expect(body).toContain("Select a conversation");
    expect(body).not.toContain("The conversation inbox is a PRO feature");
    // Inbox is now unlocked: it's the active nav item, not a locked upgrade link.
    expect(body).toContain('aria-current="page"');
  });

  it("free /engagement is locked behind PRO", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/engagement")).text();
    expect(body).toContain("Seeing who reacted to your posts is a PRO feature");
    // Engagement is shown but locked in the nav for a free instance.
    expect(body).toContain("nav-locked");
    expect(body).toContain("<span>Engagement</span>");
  });

  it("overview folds in the publishing KPIs (attention) only when publishing is entitled", async () => {
    if (!TEST_DB) return;
    // Free instance: no publishing area → no publishing dashboard section.
    expect(await (await get("/overview")).text()).not.toContain("Needs attention");
    // All-access: the unified overview shows the publishing attention/upcoming/events block.
    await licenseInstance();
    const licensed = await (await get("/overview")).text();
    expect(licensed).toContain("Needs attention");
    expect(licensed).toContain("Upcoming");
    expect(licensed).toContain("Recent events");
  });

  it("settings shows the entitled product areas (publishing/replies/core) for an all-access license", async () => {
    if (!TEST_DB) return;
    await licenseInstance(); // all-access poststack token → every area
    const body = await (await get("/settings")).text();
    expect(body).toContain("Products:");
    expect(body).toContain(">core<");
    expect(body).toContain(">publishing<");
    expect(body).toContain(">replies<");
    // Unified settings (Task 8): the publishing-providers status panel shows under a publishing license.
    expect(body).toContain("Publishing providers");
  });

  it("free settings hides the publishing-providers panel (publishing not entitled)", async () => {
    if (!TEST_DB) return;
    expect(await (await get("/settings")).text()).not.toContain("Publishing providers");
  });

  it("free settings shows no product areas (nothing entitled)", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/settings")).text();
    expect(body).not.toContain("Products:");
  });

  it("licensed /engagement shows post reactions with reactor and counts", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const CH = "1ace0000-0000-0000-0000-0000000000e1";
    await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "FB-ENG", token_encrypted: "x", webhook_secret: "s", status: "active" });
    await db.insert(s.postReactions).values([
      { workspace_id: WS, channel_id: CH, post_id: "POST-ENG", reactor_id: "U1", reactor_name: "Ola Nowak", reaction_type: "love" },
      { workspace_id: WS, channel_id: CH, post_id: "POST-ENG", reactor_id: "U2", reactor_name: "Jan Kox", reaction_type: "like" },
    ]);
    const body = await (await get("/engagement")).text();
    expect(body).toContain("POST-ENG");
    expect(body).toContain("Ola Nowak");
    expect(body).toContain("❤️"); // love emoji
    // Engagement is unlocked under a license: it renders the real reactions view (above), not the lock copy.
    expect(body).not.toContain("Seeing who reacted to your posts is a PRO feature");
  });

  it("licensed /engagement also shows DM message reactions and explains the Instagram limitation", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const CH = "1ace0000-0000-0000-0000-0000000000e2";
    await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "instagram", platform_id: "IG-ENG", token_encrypted: "x", webhook_secret: "s", status: "active" });
    const [ct] = await db.insert(s.contacts).values({ workspace_id: WS, display_name: "Maja IG" }).returning({ id: s.contacts.id });
    const [cv] = await db
      .insert(s.conversations)
      .values({ workspace_id: WS, channel_id: CH, contact_id: ct!.id, platform: "instagram" })
      .returning({ id: s.conversations.id });
    await db.insert(s.messageReactions).values({
      workspace_id: WS, channel_id: CH, conversation_id: cv!.id, contact_id: ct!.id,
      reacted_mid: "MID-1", reaction_type: "love", emoji: "❤️",
    });
    const body = await (await get("/engagement")).text();
    expect(body).toContain("Message reactions");
    expect(body).toContain("Maja IG");
    expect(body).toContain("Instagram"); // limitation note
    expect(body).toContain("post likes");
  });
});
