import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { licenseInstance } from "@/lib/license/__fixtures__/license-instance";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "eeeeeeee-0000-0000-0000-0000000000a5";
const USER = "eeeeeeee-0000-0000-0000-0000000000a6";

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
  await db.insert(s.workspaces).values({ id: WS, name: "G", slug: `g-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await licenseInstance();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});

const hx = () => ({ cookie, "hx-request": "true", "content-type": "application/json" });
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: hx(), body: JSON.stringify(body) });

describe.skipIf(!TEST_DB)("G45 — MQA19 validation fixes", () => {
  it("B02: unknown ?platform= on /channels is ignored, not a 500", async () => {
    for (const v of ["zzz", "all", "YouTube", "%22%3E%3Cimg%3E"]) {
      expect((await app.request(`/channels?platform=${v}`, { headers: { cookie } })).status).toBe(200);
    }
  });

  it("B03: New rule / New sequence errors name the field, keep the form, retarget to the form's slot", async () => {
    const rule = await post("/rules", { name: "", keywords: "hi", text: "" });
    expect(rule.status).toBe(422);
    expect(rule.headers.get("hx-retarget")).toBe("#rule-new-err-new");
    const ruleBody = await rule.text();
    expect(ruleBody).not.toContain("Invalid request data");
    expect(ruleBody).toMatch(/[Nn]ame/);
    const seq = await post("/sequences", { name: "S", steps_json: JSON.stringify([{ type: "message", content: "  " }]) });
    expect(seq.status).toBe(422);
    expect(seq.headers.get("hx-retarget")).toBe("#sequence-new-err");
    const seqBody = await seq.text();
    expect(seqBody).not.toContain("Invalid request data");
    expect(seqBody).toMatch(/step/i);
    const page = await (await app.request("/rules", { headers: { cookie } })).text();
    expect(page).toContain('id="rule-new-err-new"');
    expect(await (await app.request("/sequences", { headers: { cookie } })).text()).toContain('id="sequence-new-err"');
  });

  it("B04: a swapped 422 does not also raise the generic server-error toast", async () => {
    const page = await (await app.request("/brands", { headers: { cookie } })).text();
    expect(page).toMatch(/htmx:responseError[\s\S]{0,200}status === 422/);
  });

  it("B05: a malformed Telegram token says what is wrong, not 'Invalid request data'", async () => {
    for (const token of ["abc", "123:xxxxx", "   "]) {
      const body = await (await post("/channels/telegram/connect", { token })).text();
      expect(body).toContain("Telegram bot token");
      expect(body).not.toContain("Invalid request data");
    }
  });

  it("B06: API key name must be non-blank and at most 100 chars", async () => {
    const scopes_json = JSON.stringify(["contacts:read"]);
    for (const name of ["   ", "x".repeat(300)]) {
      const res = await post("/settings/api-keys", { name, scopes_json });
      const body = await res.text();
      expect(body).not.toContain("sk_live_");
      expect(body).not.toContain("Invalid request data");
    }
    expect((await db.select().from(s.apiKeys).where(eq(s.apiKeys.workspace_id, WS))).length).toBe(0);
  });

  it("B07: length limits are enforced on the server; the AI prompt is rejected, never truncated", async () => {
    const brand = await app.request("/brands", { method: "POST", headers: { ...hx(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: "k".repeat(200), name: "N" }) });
    expect(brand.status).toBe(422);
    const brand2 = await app.request("/brands", { method: "POST", headers: { ...hx(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: "ok", name: "N".repeat(5000) }) });
    expect(brand2.status).toBe(422);
    const ai = await post("/settings/ai-draft-prompt", { ai_draft_prompt_dm: "p".repeat(4001) });
    expect(ai.status).toBe(422);
    expect(await ai.text()).toContain("4000");
    const [ws] = await db.select().from(s.workspaces).where(eq(s.workspaces.id, WS));
    expect(ws!.ai_draft_prompt_dm).toBeNull();
    const rule = await post("/rules", { name: "R", keywords: "hi", text: "ok", ai_rephrase: "true", tone: "t".repeat(101) });
    expect(rule.status).toBe(422);
  });

  it("B11: Compose accepts only http(s) media URLs and explains overlong fields", async () => {
    const compose = (over: Record<string, unknown>) => {
      const payload = { brand: "b", title: "T", mediaUrl: "https://x.example/a.mp4", posts: [{ platform: "facebook" }], ...over };
      return app.request("/compose", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    };
    for (const mediaUrl of ["javascript:alert(1)", "data:text/html,x", "ftp://x.example/y.mp4"]) {
      const res = await compose({ mediaUrl });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("http(s)");
    }
    const long = await compose({ title: "t".repeat(5000) });
    expect(long.status).toBe(422);
    expect(await long.text()).not.toContain("Could not read the form");
  });
});
