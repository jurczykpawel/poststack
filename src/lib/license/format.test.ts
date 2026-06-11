import { describe, it, expect, beforeAll } from "vitest";
import { parseClaims, verifyLicense } from "@/lib/license/format";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";

const PRODUCT = "replystack-pro";

let key: TestKey;
let otherKey: TestKey;

beforeAll(async () => {
  key = await makeTestKey("kid-1");
  otherKey = await makeTestKey("kid-2");
});

describe("parseClaims", () => {
  it("decodes the payload segment", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", order: "ord_42" }));
    expect(parseClaims(token)?.order).toBe("ord_42");
  });

  it("returns null for a malformed token", () => {
    expect(parseClaims("not-a-token")).toBeNull();
    expect(parseClaims("")).toBeNull();
  });
});

describe("verifyLicense", () => {
  it("accepts a valid token and returns its tier", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", tier: "pro" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual(expect.objectContaining({ valid: true, tier: "pro" }));
  });

  it("rejects a malformed token", async () => {
    const res = await verifyLicense("garbage", [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects an unknown kid", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-unknown" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual({ valid: false, reason: "unknown_kid" });
  });

  it("rejects a bad signature (wrong key for kid)", async () => {
    // Sign with otherKey but claim kid-1, whose published key won't verify it.
    const token = await otherKey.sign(makeClaims({ kid: "kid-1" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects an expired token", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", exp: 1_000 }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a token for a different product", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", product: "some-other-product" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual({ valid: false, reason: "wrong_product" });
  });

  it("treats a null exp as a non-expiring token", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", exp: null }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual(expect.objectContaining({ valid: true }));
  });
});
