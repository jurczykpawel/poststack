import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "11ce5e88-0000-0000-0000-0000000000a1";
const USER = "11ce5e88-0000-0000-0000-0000000000a2";

let app: Hono;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let jwks: typeof import("@/lib/license/jwks");
let jwksUrl: string;
let cookie: string;
let key: TestKey;
let otherCookie: string;
let env: typeof import("@/lib/env").env;
const OTHER_WS = "11ce5e88-0000-0000-0000-0000000000b1";
const OTHER_USER = "11ce5e88-0000-0000-0000-0000000000b2";

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}
async function warmJwks() {
  await jwks.getJwks({ url: jwksUrl, fetchImpl: jwksFetch([key.jwk]), now: Date.now() });
}
function postLicense(token: string) {
  return app.request("/settings/license", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
  ({ env: { LICENSE_JWKS_URL: jwksUrl } } = await import("@/lib/env"));
  ({ env } = await import("@/lib/env"));
  const { buildApp } = await import("../app");
  app = buildApp();
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  otherCookie = `session=${await signSession(OTHER_USER, OTHER_WS)}`;
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS, OTHER_WS]));
  await db.delete(s.users).where(inArray(s.users.id, [USER, OTHER_USER]));
  Object.assign(env, { INSTANCE_ADMIN_EMAILS: `u-${USER}@test.local` });
  await db.insert(s.users).values({ id: USER, email: `u-${USER}@test.local` });
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.users).values({ id: OTHER_USER, email: `u-${OTHER_USER}@test.local` });
  await db.insert(s.workspaces).values({ id: OTHER_WS, name: "Other", slug: `m-${OTHER_WS}` });
  await db.insert(s.workspaceMembers).values({ workspace_id: OTHER_WS, user_id: OTHER_USER, role: "owner" });
  await db.delete(s.instanceLicense);
  await db.delete(s.instanceSettings).where(eq(s.instanceSettings.key, "INSTANCE_BRANDING"));
  (await import("@/lib/settings/config")).invalidateConfigCache();
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS, OTHER_WS]));
  await db.delete(s.users).where(inArray(s.users.id, [USER, OTHER_USER]));
  await db.delete(s.instanceLicense);
  await db.delete(s.instanceSettings).where(eq(s.instanceSettings.key, "INSTANCE_BRANDING"));
  (await import("@/lib/settings/config")).invalidateConfigCache();
  await db.$client.end();
});

const branding = { name: "Orchard", logoUrl: "/brand-logo.svg", faviconUrl: "", accent: "#12ab34", theme: "light", publicUrl: "https://orchard.example", contactEmail: "help@orchard.example", footer: "Orchard team" };
function save(body: unknown = branding, as = cookie) {
  return app.request("/settings/branding", { method: "POST", headers: { cookie: as, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function activate(tier = "business") {
  await warmJwks();
  await postLicense(await key.sign(makeClaims({ kid: "kid-1", tier })));
}
describe("instance branding settings", () => {
  it("requires an operator session", async () => {
    await activate();
    expect((await save(branding, otherCookie)).status).toBe(403);
    expect((await save(branding, "")).status).toBe(302);
    expect(await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, "INSTANCE_BRANDING") })).toBeUndefined();
  });
  it.each(["free", "pro"])("requires Business on %s", async (tier) => {
    if (tier === "pro") await activate(tier);
    const response = await save();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("pro_required");
    expect(await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, "INSTANCE_BRANDING") })).toBeUndefined();
  });
  it("validates before storing and protects the generic settings path", async () => {
    await activate();
    expect((await save({ ...branding, accent: "invalid" })).status).toBe(400);
    const response = await app.request("/settings/credentials", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ key: "INSTANCE_BRANDING", value: JSON.stringify(branding) }) });
    expect(response.status).toBe(400);
  });
  it("stores one configuration and rebrands public and dashboard pages", async () => {
    await activate();
    expect((await save()).status).toBe(200);
    const row = await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, "INSTANCE_BRANDING") });
    expect(row?.value_encrypted).toBeTruthy();
    expect(row?.value_encrypted).not.toContain("Orchard");
    for (const path of ["/", "/privacy", "/terms", "/login", "/register", "/overview", "/settings", "/channels", "/api/docs", "/api/v1", "/not-a-page"]) {
      const response = await app.request(path, { headers: ["/", "/privacy", "/terms"].includes(path) ? {} : { cookie } });
      const body = await response.text();
      expect(body, path).toContain("Orchard");
      expect(body, path).not.toContain("PostStack");
      if (path !== "/api/docs" && path !== "/api/v1") expect(body, path).toContain("/instance-favicon.svg");
    }
    for (const path of ["/robots.txt", "/llms.txt", "/sitemap-index.xml", "/sitemap-0.xml"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      const body = await response.text();
      expect(body, path).toContain("https://orchard.example");
      expect(body, path).not.toContain("PostStack");
      expect(body, path).not.toContain("poststack.techskills.academy");
    }
    const icon = await app.request("/instance-favicon.svg");
    expect(await icon.text()).toContain("#12ab34");
  });
  it("lets the operator restore the default identity", async () => {
    await activate();
    await save();
    expect((await save({ reset: true })).status).toBe(200);
    expect(await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, "INSTANCE_BRANDING") })).toBeUndefined();
    expect(await (await app.request("/login")).text()).toContain("PostStack");
  });
  it("returns to the default identity when the license is removed", async () => {
    await activate();
    await save();
    await gate.clearLicense();
    const body = await (await app.request("/login")).text();
    expect(body).toContain("PostStack");
    expect(body).not.toContain("Orchard");
  });
  it("renders escaped identity text", async () => {
    await activate();
    await save({ ...branding, name: 'Orchard <b> & "Studio"', footer: '<b>Team</b>' });
    const body = await (await app.request("/login")).text();
    expect(body).toContain("Orchard &lt;b&gt; &amp;");
    expect(body).not.toContain("<b>Team</b>");
  });
});
