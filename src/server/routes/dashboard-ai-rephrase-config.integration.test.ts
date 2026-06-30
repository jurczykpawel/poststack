import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

// AIPROMPT1: workspace-default rephrase prompt — render + persist (PRO-gated), mirroring the AI-draft
// prompt settings. The per-rule override (tone/custom_prompt) is covered by the rules API + the
// resolver unit tests; this exercises the workspace level + the PRO gate.
const TEST_DB = process.env.TEST_DATABASE_URL;

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let cookie: string;

const WS = "eeeeeeee-0000-0000-0000-0000000000c1";
const USER = "eeeeeeee-0000-0000-0000-0000000000c2";

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
async function wsPrompt(): Promise<string | null> {
  const row = await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, WS), columns: { ai_rephrase_prompt: true } });
  return row?.ai_rephrase_prompt ?? null;
}

describe("Workspace default rephrase prompt — render + persist (AIPROMPT1)", () => {
  it("GET /settings (PRO) renders the rephrase-prompt textarea + the built-in default", async () => {
    if (!TEST_DB) return;
    const html = await (await get("/settings")).text();
    expect(html).toContain('name="ai_rephrase_prompt"');
    expect(html).toContain("Built-in default"); // AIPROMPT2 visibility of the fallback
  });

  it("GET /settings (free) shows a PRO upsell, no textarea", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const html = await (await get("/settings")).text();
    expect(html).not.toContain('name="ai_rephrase_prompt"');
  });

  it("POST persists ai_rephrase_prompt (workspace-scoped)", async () => {
    if (!TEST_DB) return;
    const res = await postJson("/settings/ai-rephrase-prompt", { ai_rephrase_prompt: "Rephrase concisely in Polish." });
    expect(res.status).toBe(200);
    expect(await wsPrompt()).toBe("Rephrase concisely in Polish.");
  });

  it("POST caps the stored prompt at 4000 chars", async () => {
    if (!TEST_DB) return;
    const res = await postJson("/settings/ai-rephrase-prompt", { ai_rephrase_prompt: "a".repeat(5000) });
    expect(res.status).toBe(200);
    expect((await wsPrompt())?.length).toBe(4000);
  });

  it("POST with a blank prompt stores null", async () => {
    if (!TEST_DB) return;
    await db.update(s.workspaces).set({ ai_rephrase_prompt: "old" }).where(eq(s.workspaces.id, WS));
    const res = await postJson("/settings/ai-rephrase-prompt", { ai_rephrase_prompt: "   " });
    expect(res.status).toBe(200);
    expect(await wsPrompt()).toBeNull();
  });

  it("free instance → 403, no write", async () => {
    if (!TEST_DB) return;
    await gate.clearLicense();
    gate.invalidateLicenseCache();
    const res = await postJson("/settings/ai-rephrase-prompt", { ai_rephrase_prompt: "nope" });
    expect(res.status).toBe(403);
    expect(await wsPrompt()).toBeNull();
  });
});
