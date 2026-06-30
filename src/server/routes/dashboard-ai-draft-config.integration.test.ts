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

const WS = "eeeeeeee-0000-0000-0000-0000000000b1";
const USER = "eeeeeeee-0000-0000-0000-0000000000b2";
const CH = "eeeeeeee-0000-0000-0000-0000000000b3";
const FOREIGN = "eeeeeeee-0000-0000-0000-0000000000b9";

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
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-B", token_encrypted: "x", webhook_secret: "s", status: "active" });
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
function postForm(path: string, fields: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "hx-request": "true" },
    body: new URLSearchParams(fields).toString(),
  });
}

async function wsPrompt(): Promise<string | null> {
  const row = await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, WS), columns: { ai_draft_prompt: true } });
  return row?.ai_draft_prompt ?? null;
}
async function chRow() {
  return db.query.channels.findFirst({ where: eq(s.channels.id, CH) });
}

describe("Workspace default AI-draft prompt — render + persist (Task 8)", () => {
  it("GET /settings (PRO) renders the default-prompt textarea", async () => {
    if (!TEST_DB) return;
    const html = await (await get("/settings")).text();
    expect(html).toContain('name="ai_draft_prompt"');
  });

  it("GET /settings (free) shows a PRO upsell, no textarea", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const html = await (await get("/settings")).text();
    expect(html).not.toContain('name="ai_draft_prompt"');
  });

  it("POST persists ai_draft_prompt (workspace-scoped)", async () => {
    if (!TEST_DB) return;
    const res = await postJson("/settings/ai-draft-prompt", { ai_draft_prompt: "Reply warmly." });
    expect(res.status).toBe(200);
    expect(await wsPrompt()).toBe("Reply warmly.");
  });

  it("POST caps the stored prompt at 4000 chars (parity with the per-channel prompt)", async () => {
    if (!TEST_DB) return;
    const res = await postJson("/settings/ai-draft-prompt", { ai_draft_prompt: "a".repeat(5000) });
    expect(res.status).toBe(200);
    expect((await wsPrompt())?.length).toBe(4000);
  });

  it("POST with a blank prompt stores null", async () => {
    if (!TEST_DB) return;
    await db.update(s.workspaces).set({ ai_draft_prompt: "old" }).where(eq(s.workspaces.id, WS));
    const res = await postJson("/settings/ai-draft-prompt", { ai_draft_prompt: "   " });
    expect(res.status).toBe(200);
    expect(await wsPrompt()).toBeNull();
  });

  it("free instance → 403, no write", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const res = await postJson("/settings/ai-draft-prompt", { ai_draft_prompt: "nope" });
    expect(res.status).toBe(403);
    expect(await wsPrompt()).toBeNull();
  });
});

describe("Per-channel AI-draft settings — persist (Task 8)", () => {
  it("POST writes all six fields (workspace-scoped)", async () => {
    if (!TEST_DB) return;
    const res = await postForm(`/channels/${CH}/ai-draft`, {
      enabled: "1",
      target: "both",
      prompt: "Channel voice.",
      autosendDm: "1",
      autosendPublic: "1",
    });
    expect(res.status).toBe(200);
    const row = await chRow();
    expect(row?.ai_draft_enabled).toBe(true);
    expect(row?.ai_draft_target).toBe("both");
    expect(row?.ai_draft_prompt).toBe("Channel voice.");
    expect(row?.ai_draft_autosend_dm).toBe(true);
    expect(row?.ai_draft_autosend_public).toBe(true);
  });

  it("unchecked toggles persist as false; blank prompt → null (inherit)", async () => {
    if (!TEST_DB) return;
    await db.update(s.channels).set({ ai_draft_enabled: true, ai_draft_prompt: "x", ai_draft_autosend_dm: true }).where(eq(s.channels.id, CH));
    const res = await postForm(`/channels/${CH}/ai-draft`, { target: "dm", prompt: "" });
    expect(res.status).toBe(200);
    const row = await chRow();
    expect(row?.ai_draft_enabled).toBe(false);
    expect(row?.ai_draft_prompt).toBeNull();
    expect(row?.ai_draft_autosend_dm).toBe(false);
    expect(row?.ai_draft_autosend_public).toBe(false);
  });

  it("foreign / missing channel → 404", async () => {
    if (!TEST_DB) return;
    const res = await postForm(`/channels/${FOREIGN}/ai-draft`, { target: "dm" });
    expect(res.status).toBe(404);
  });

  it("invalid target → 422, no write", async () => {
    if (!TEST_DB) return;
    const res = await postForm(`/channels/${CH}/ai-draft`, { enabled: "1", target: "carrier-pigeon" });
    expect(res.status).toBe(422);
    const row = await chRow();
    expect(row?.ai_draft_enabled).toBe(false);
  });

  it("free instance → 403, no write", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const res = await postForm(`/channels/${CH}/ai-draft`, { enabled: "1", target: "dm" });
    expect(res.status).toBe(403);
    const row = await chRow();
    expect(row?.ai_draft_enabled).toBe(false);
  });
});
