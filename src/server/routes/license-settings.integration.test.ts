import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
  ({ env: { LICENSE_JWKS_URL: jwksUrl } } = await import("@/lib/env"));
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
  await db.delete(s.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
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
    expect(body).toContain("License rejected: malformed");
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
