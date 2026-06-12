import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";
import type { JwksKey } from "@/lib/license/format";

// Real-Postgres integration for the license store + gate. Required env is set
// before the dynamic imports so the validated env singleton picks it up.
const TEST_DB = process.env.TEST_DATABASE_URL;

let gate: typeof import("./gate");
let store: typeof import("./store");
let jwks: typeof import("./jwks");
let revocation: typeof import("./revocation");
let db: typeof import("@/lib/db").db;
let schema: typeof import("@/db/schema");

let key: TestKey;
let badKey: TestKey;

function jwksFetch(keys: JwksKey[]): (url: string) => Promise<Response> {
  return async () => new Response(JSON.stringify({ keys }), { status: 200 });
}
// Routes by URL: the JWKS path gets keys, the revocation path gets the revoked-order list.
function fetchWith(keys: JwksKey[], revoked: string[] = []): (url: string) => Promise<Response> {
  return async (url: string) =>
    url.includes("/revoked")
      ? new Response(JSON.stringify({ orders: revoked }), { status: 200 })
      : new Response(JSON.stringify({ keys }), { status: 200 });
}
const failFetch = async () => {
  throw new Error("jwks unreachable");
};

beforeAll(async () => {
  if (!TEST_DB) return;
  key = await makeTestKey("kid-1");
  badKey = await makeTestKey("kid-1"); // same kid, different key -> bad signature
  process.env.DATABASE_URL = TEST_DB;
  process.env.JWT_SECRET ??= "test-jwt-secret-至少-32-characters-长!!";
  process.env.TOKEN_ENCRYPTION_KEY ??= "0".repeat(64);
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-chars!!";
  // REPLYSTACK_LICENSE_KEY intentionally left empty in this file (no env token).
  gate = await import("./gate");
  store = await import("./store");
  jwks = await import("./jwks");
  revocation = await import("./revocation");
  ({ db } = await import("@/lib/db"));
  schema = await import("@/db/schema");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
  jwks.__resetJwksCache();
  revocation.__resetRevocationCache();
  gate.invalidateLicenseCache();
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(schema.instanceLicense);
});

describe("license gate (real Postgres)", () => {
  it("is free with no token anywhere", async () => {
    if (!TEST_DB) return;
    const state = await gate.refreshLicense({ fetchImpl: jwksFetch([key.jwk]) });
    expect(state.status).toBe("none");
    expect(state.features.size).toBe(0);
    expect(await gate.hasFeature("personalization")).toBe(false);
  });

  it("activates a valid token and unlocks its tier features", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    const res = await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    expect(res.ok).toBe(true);
    expect(res.state.status).toBe("active");
    expect(res.state.tier).toBe("pro");
    expect(await gate.hasFeature("personalization")).toBe(true);
  });

  it("stores the token encrypted, never in plaintext", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1" }));
    await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    const row = await db.query.instanceLicense.findFirst();
    expect(row?.token).toBeTruthy();
    expect(row?.token).not.toBe(token);
    expect(row?.token).toContain(":"); // iv:authTag:ciphertext
    const { token: resolved } = await store.resolveTokenSource();
    expect(resolved).toBe(token); // round-trips back to plaintext
  });

  it("rejects a bad-signature token without storing it", async () => {
    if (!TEST_DB) return;
    const token = await badKey.sign(makeClaims({ kid: "kid-1" }));
    const res = await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_signature");
    const row = await db.query.instanceLicense.findFirst();
    expect(row?.token).toBeNull();
    expect(row?.status).toBe("invalid");
  });

  it("treats an expired token as expired/free (no feature leak)", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", exp: 1000 }));
    await store.persistLicenseState({ token, status: "active", tier: "pro", expiresAt: null, lastError: null });
    const state = await gate.refreshLicense({ fetchImpl: jwksFetch([key.jwk]) });
    expect(state.status).toBe("expired");
    expect(await gate.hasFeature("personalization")).toBe(false);
  });

  it("requireFeature throws ProRequiredError when locked", async () => {
    if (!TEST_DB) return;
    await gate.refreshLicense({ fetchImpl: jwksFetch([key.jwk]) });
    await expect(gate.requireFeature("personalization")).rejects.toBeInstanceOf(gate.ProRequiredError);
  });

  it("serves stale keys during a JWKS outage (PRO survives)", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) }); // warms cache + snapshot
    gate.invalidateLicenseCache();
    const state = await gate.refreshLicense({ fetchImpl: failFetch });
    expect(state.status).toBe("active"); // stale in-memory cache / DB snapshot
    expect(state.features.has("personalization")).toBe(true);
  });

  it("revokes an active token whose order is on the seller CRL", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "ord-refunded" }));
    await store.persistLicenseState({ token, status: "active", tier: "pro", expiresAt: null, lastError: null });
    const state = await gate.refreshLicense({ fetchImpl: fetchWith([key.jwk], ["ord-refunded"]) });
    expect(state.status).toBe("invalid");
    expect(state.features.size).toBe(0);
    const row = await db.query.instanceLicense.findFirst();
    expect(row?.last_error).toBe("revoked");
  });

  it("setLicense rejects a token whose order is revoked", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "ord-refunded" }));
    const res = await gate.setLicense(token, { fetchImpl: fetchWith([key.jwk], ["ord-refunded"]) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("revoked");
    const row = await db.query.instanceLicense.findFirst();
    expect(row?.token).toBeNull(); // a revoked token is never stored
  });

  it("keeps an active token whose order is NOT on the CRL", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "ord-good" }));
    const res = await gate.setLicense(token, { fetchImpl: fetchWith([key.jwk], ["someone-else"]) });
    expect(res.ok).toBe(true);
    expect(res.state.status).toBe("active");
  });

  it("fails OPEN: an unreachable CRL never revokes a valid token", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro", order: "ord-x" }));
    // JWKS resolves, but the revocation endpoint is down → must NOT lock out the customer.
    const fetchImpl = async (url: string) => {
      if (url.includes("/revoked")) throw new Error("crl down");
      return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 });
    };
    const res = await gate.setLicense(token, { fetchImpl });
    expect(res.ok).toBe(true);
    expect(res.state.status).toBe("active");
  });

  it("clearing a stored token reverts to free", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    const after = await gate.clearLicense({ fetchImpl: jwksFetch([key.jwk]) });
    expect(after.status).toBe("none");
    expect(await gate.hasFeature("personalization")).toBe(false);
  });

  it("caches state and invalidates on demand", async () => {
    if (!TEST_DB) return;
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    await gate.setLicense(token, { fetchImpl: jwksFetch([key.jwk]) });
    // Underlying token cleared directly in DB, but cache should still report active.
    await db.update(schema.instanceLicense).set({ token: null });
    expect((await gate.getInstanceLicense()).status).toBe("active");
    gate.invalidateLicenseCache();
    expect((await gate.getInstanceLicense({ fetchImpl: jwksFetch([key.jwk]) })).status).toBe("none");
  });
});
