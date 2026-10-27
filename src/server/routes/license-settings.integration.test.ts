import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
const WS = "11ce5e77-0000-0000-0000-0000000000a1";
const USER = "11ce5e77-0000-0000-0000-0000000000a2";

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
const OTHER_WS = "11ce5e77-0000-0000-0000-0000000000b1";
const OTHER_USER = "11ce5e77-0000-0000-0000-0000000000b2";

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
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(inArray(s.workspaces.id, [WS, OTHER_WS]));
  await db.delete(s.users).where(inArray(s.users.id, [USER, OTHER_USER]));
  await db.delete(s.instanceLicense);
  await db.$client.end();
});

describe("settings → License section", () => {
  it("renders a free/none status with a Buy PRO link", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("License");
    expect(body).toContain("Buy PRO");
    expect(body).toContain(">none<");
  });

  it("activates a valid token via the form and shows the tier", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    const res = await postLicense(token);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("License activated.");
    expect(body).toContain("active");
    expect(body).toContain("personalization");
    expect(body).not.toContain(token); // token never rendered back
  });

  it("rejects an invalid token with a reason", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    const res = await postLicense("garbage");
    expect(res.status).toBe(200); // htmx partial, error shown inline
    const body = await res.text();
    expect(body).toContain("This license token is invalid."); // friendly message for reason=malformed
  });

  it("removes a stored license", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    await postLicense(await key.sign(makeClaims({ kid: "kid-1", tier: "pro" })));
    const res = await app.request("/settings/license/clear", { method: "POST", headers: { cookie, "content-type": "application/json" } });
    const body = await res.text();
    expect(body).toContain("License removed.");
    expect(body).toContain(">none<");
  });
});

describe("instance operator settings", () => {
  const writes = [
    ["/settings/credentials", "POST", { key: "META_APP_SECRET", value: "test-value" }],
    ["/settings/credentials", "POST", { key: "META_APP_SECRET", clear: "1" }],
    ["/settings/license", "POST", { token: "garbage" }],
    ["/settings/license/clear", "POST", {}],
    ["/api/v1/license", "POST", { token: "garbage" }],
    ["/api/v1/license", "DELETE", {}],
  ] as const;

  it.each(writes)("requires an operator for %s %s %j", async (path, method, body) => {
    const before = await db.select().from(s.instanceSettings);
    const licenseBefore = await db.select().from(s.instanceLicense);
    const response = await app.request(path, {
      method, headers: { cookie: otherCookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(403);
    expect(await db.select().from(s.instanceSettings)).toEqual(before);
    expect(await db.select().from(s.instanceLicense)).toEqual(licenseBefore);
  });

  it("shows managed sections without instance forms or credential metadata", async () => {
    await warmJwks();
    await postLicense(await key.sign(makeClaims({ kid: "kid-1", tier: "pro" })));
    const response = await app.request("/settings", { headers: { cookie: otherCookie } });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Managed by the instance operator");
    expect(body).not.toContain('hx-post="/settings/credentials"');
    expect(body).not.toContain('hx-post="/settings/license"');
    expect(body).not.toContain('hx-post="/settings/license/clear"');
    expect(body).not.toContain("META_APP_SECRET");
    expect(body).toContain('hx-post="/settings/retention"');
  });

  it("allows the operator to set and clear credentials", async () => {
    for (const body of [{ key: "META_APP_SECRET", value: "test-value" }, { key: "META_APP_SECRET", clear: "1" }]) {
      const response = await app.request("/settings/credentials", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      const row = await db.query.instanceSettings.findFirst({ where: eq(s.instanceSettings.key, "META_APP_SECRET") });
      if ("value" in body) {
        expect(row?.value_encrypted).toBeTruthy();
        expect(row?.value_encrypted).not.toBe(body.value);
      } else expect(row).toBeUndefined();
    }
  });

  it("keeps retention scoped to the member's workspace", async () => {
    const response = await app.request("/settings/retention", {
      method: "POST", headers: { cookie: otherCookie, "content-type": "application/json" },
      body: JSON.stringify({ message_retention_days: 45 }),
    });
    expect(response.status).toBe(200);
    expect((await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, OTHER_WS) }))?.message_retention_days).toBe(45);
    expect((await db.query.workspaces.findFirst({ where: eq(s.workspaces.id, WS) }))?.message_retention_days).toBeNull();
  });
});


describe("instance operator selection", () => {
  async function operator(userId: string, authMethod: "session" | "api_key" = "session") {
    const { isInstanceOperator } = await import("@/lib/auth/instance-operator");
    return isInstanceOperator({ userId, workspaceId: WS, authMethod, scopes: [] });
  }

  it("matches a trimmed, case-insensitive email list against current user data", async () => {
    env.INSTANCE_ADMIN_EMAILS = `missing@test.local, U-${OTHER_USER}@TEST.LOCAL , `;
    expect(await operator(OTHER_USER)).toBe(true);
    expect(await operator(USER)).toBe(false);
    await db.update(s.users).set({ email: "changed@test.local" }).where(eq(s.users.id, OTHER_USER));
    expect(await operator(OTHER_USER)).toBe(false);
  });

  it("uses the earliest account only when the list is empty", async () => {
    await db.update(s.users).set({ created_at: new Date("2000-01-01") }).where(eq(s.users.id, USER));
    env.INSTANCE_ADMIN_EMAILS = " , ";
    expect(await operator(USER)).toBe(true);
    expect(await operator(OTHER_USER)).toBe(false);
    env.INSTANCE_ADMIN_EMAILS = "missing@test.local";
    expect(await operator(USER)).toBe(false);
  });

  it("orders equal creation dates by user id", async () => {
    await db.update(s.users).set({ created_at: new Date("2000-01-01") }).where(inArray(s.users.id, [USER, OTHER_USER]));
    env.INSTANCE_ADMIN_EMAILS = "";
    expect(await operator(USER)).toBe(true);
    expect(await operator(OTHER_USER)).toBe(false);
  });

  it("requires an existing user session", async () => {
    expect(await operator(USER, "api_key")).toBe(false);
    await db.delete(s.users).where(eq(s.users.id, USER));
    expect(await operator(USER)).toBe(false);
    const response = await app.request("/settings/license/clear", { method: "POST", headers: { cookie } });
    expect(response.status).toBe(403);
  });

  it("renders instance forms for the operator", async () => {
    const body = await (await app.request("/settings", { headers: { cookie } })).text();
    expect(body).toContain('hx-post="/settings/credentials"');
    expect(body).toContain('hx-post="/settings/license"');
    expect(body).toContain("TikTok: zawsze potwierdzaj przy wysyłce");
    expect(body).toContain('option value="false" selected');
  });

  it("requires current workspace membership on instance writes", async () => {
    await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.user_id, USER));
    expect((await app.request("/settings/license/clear", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await app.request("/api/v1/license", { method: "DELETE", headers: { cookie } })).status).toBe(401);
  });
});
