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

  it("free /channels locks Telegram and shows Gmail soon", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/channels")).text();
    expect(body).toContain("🔒 Telegram (PRO)");
    expect(body).toContain("Gmail — soon");
    expect(body).not.toContain("@click=\"tg = !tg\""); // telegram connect toggle hidden
  });

  it("free /channels locks a 2nd Facebook once one is connected", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      workspace_id: WS, platform: "facebook", platform_id: "FB-UI", token_encrypted: "x", webhook_secret: "s", status: "active",
    });
    const body = await (await get("/channels")).text();
    expect(body).toContain("🔒 Facebook (PRO)");
    expect(body).toContain("one Facebook + one Instagram channel");
  });

  it("licensed /channels unlocks Telegram", async () => {
    if (!TEST_DB) return;
    await licenseInstance();
    const body = await (await get("/channels")).text();
    expect(body).toContain("@click=\"tg = !tg\"");
    expect(body).not.toContain("🔒 Telegram (PRO)");
  });

  it("free /overview shows aggregate stats and locks Inbox/Contacts in the nav", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/overview")).text();
    expect(body).toContain("Overview");
    expect(body).toContain("Sent today");
    // Nav: Overview is free; Inbox + Contacts are locked.
    expect(body).toContain("Inbox 🔒");
    expect(body).toContain("Contacts 🔒");
    // Free overview points at the locked per-person view.
    expect(body).toContain("Open individual conversations with");
  });

  it("free /inbox is locked behind PRO (no conversation list)", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/inbox")).text();
    expect(body).toContain("The conversation inbox is a PRO feature");
    expect(body).not.toContain("Select a conversation"); // the real inbox is not rendered
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
    expect(body).not.toContain("Inbox 🔒");
  });

  it("free /engagement is locked behind PRO", async () => {
    if (!TEST_DB) return;
    const body = await (await get("/engagement")).text();
    expect(body).toContain("Seeing who reacted to your posts is a PRO feature");
    expect(body).toContain("Engagement 🔒");
  });

  it("settings shows the entitled product areas (publishing/replies/core) for an all-access license", async () => {
    if (!TEST_DB) return;
    await licenseInstance(); // all-access poststack token → every area
    const body = await (await get("/settings")).text();
    expect(body).toContain("Products:");
    expect(body).toContain(">core<");
    expect(body).toContain(">publishing<");
    expect(body).toContain(">replies<");
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
    expect(body).not.toContain("Engagement 🔒");
  });
});
