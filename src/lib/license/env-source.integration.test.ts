import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

// Precedence: a panel-stored token (DB) wins over the LICENSE_KEY env
// token; with no DB token the env token is the fallback. The env token must be
// signed and set before the env module loads, so it's built first in beforeAll.
const TEST_DB = process.env.TEST_DATABASE_URL;

let gate: typeof import("./gate");
let store: typeof import("./store");
let jwks: typeof import("./jwks");
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");
let jwksUrl: string;
let key: TestKey;

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  const envToken = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "env-order" }));
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.LICENSE_KEY = envToken; // set BEFORE importing env
  gate = await import("./gate");
  store = await import("./store");
  jwks = await import("./jwks");
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
  ({ env: { LICENSE_JWKS_URL: jwksUrl } } = await import("@/lib/env"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
  gate.invalidateLicenseCache();
  jwks.__resetJwksCache();
  await jwks.getJwks({ url: jwksUrl, fetchImpl: jwksFetch([key.jwk]), now: Date.now() }); // warm
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
  delete process.env.LICENSE_KEY;
  await db.$client.end();
});

describe("license token source precedence", () => {
  it("uses the env token when no token is stored in the DB", async () => {
    if (!TEST_DB) return;
    const { token, source } = await store.resolveTokenSource();
    expect(source).toBe("env");
    expect(token).toBeTruthy();
    const state = await gate.getInstanceLicense();
    expect(state.status).toBe("active");
    expect(state.source).toBe("env");
    expect(state.features.has("personalization")).toBe(true);
  });

  it("prefers the DB (panel) token over the env token", async () => {
    if (!TEST_DB) return;
    const dbToken = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "db-order" }));
    await gate.setLicense(dbToken, { fetchImpl: jwksFetch([key.jwk]) });
    const { source } = await store.resolveTokenSource();
    expect(source).toBe("db");
    expect((await gate.getInstanceLicense()).source).toBe("db");
  });

  it("reverts to the env token after the DB token is cleared", async () => {
    if (!TEST_DB) return;
    await gate.setLicense(await key.sign(makeClaims({ kid: "kid-1", order: "db-order" })), {
      fetchImpl: jwksFetch([key.jwk]),
    });
    const after = await gate.clearLicense({ fetchImpl: jwksFetch([key.jwk]) });
    expect(after.status).toBe("active");
    expect(after.source).toBe("env");
  });
});
