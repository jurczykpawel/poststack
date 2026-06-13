import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createHash } from "crypto";
import { inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_licensetest_0123456789abcdef0123456789abcdef";
const WS = "1ce50000-0000-0000-0000-000000000001";
const authHeaders = { authorization: `Bearer ${RAW_KEY}` };

let app: Hono;
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let gate: typeof import("@/lib/license/gate");
let jwks: typeof import("@/lib/license/jwks");
let jwksUrl: string;
let key: TestKey;

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

// Warm the process-global JWKS cache so the handler's setLicense (which uses the
// default fetch) verifies offline against the test key.
async function warmJwks() {
  await jwks.getJwks({ url: jwksUrl, fetchImpl: jwksFetch([key.jwk]), now: Date.now() });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";

  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  gate = await import("@/lib/license/gate");
  jwks = await import("@/lib/license/jwks");
  ({ env: { LICENSE_JWKS_URL: jwksUrl } } = await import("@/lib/env"));
  const { buildApp } = await import("../../../app");
  app = buildApp();

  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS]));
  await db.insert(schema.workspaces).values({ id: WS, name: "Lic", slug: `lic-${WS}` });
  await db.insert(schema.apiKeys).values({
    workspace_id: WS,
    name: "lic key",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: "sk_live_licensetest",
  });
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
  await db.delete(schema.workspaces).where(inArray(schema.workspaces.id, [WS]));
  await db.$client.end();
});

describe("/api/v1/license (real Postgres)", () => {
  it("GET requires auth", async () => {
    if (!TEST_DB) return;
    expect((await app.request("/api/v1/license")).status).toBe(401);
  });

  it("GET reports free/none when no license is set", async () => {
    if (!TEST_DB) return;
    const res = await app.request("/api/v1/license", { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("none");
    expect(body.data.features).toEqual([]);
    expect(body.data).not.toHaveProperty("token");
  });

  it("POST rejects a malformed token with 422 + reason", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    const res = await app.request("/api/v1/license", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token: "garbage" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_LICENSE");
    expect(body.error.details.reason).toBe("malformed");
  });

  it("POST activates a valid pro token (no multitenancy, no token echoed)", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    const res = await app.request("/api/v1/license", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("active");
    expect(body.data.tier).toBe("pro");
    expect(body.data.features).toContain("personalization");
    expect(body.data.features).not.toContain("multi_workspace");
    expect(JSON.stringify(body)).not.toContain(token); // token never leaves the server

    const row = await db.query.instanceLicense.findFirst();
    expect(row?.token).toBeTruthy();
    expect(row?.token).not.toBe(token); // stored encrypted
  });

  it("DELETE reverts to free", async () => {
    if (!TEST_DB) return;
    await warmJwks();
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    await app.request("/api/v1/license", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const del = await app.request("/api/v1/license", { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(200);
    expect((await del.json()).data.status).toBe("none");
  });
});
