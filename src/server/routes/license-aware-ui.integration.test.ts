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
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `rs_session=${await signSession(USER, WS)}`;
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
    expect(body).toContain("Drip sequences are a PRO feature");
    expect(body).not.toContain("Create sequence");
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
});
