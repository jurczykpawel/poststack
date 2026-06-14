import { describe, it, expect, beforeAll } from "vitest";
import { parseClaims, verifyLicense, domainMatches, hostFromUrl } from "@/lib/license/format";
import { makeTestKey, makeClaims, type TestKey } from "@/lib/license/__fixtures__/keys";

const PRODUCT = "poststack"; // matches makeClaims default product

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

  it("accepts a token whose product is in a comma-separated allowlist", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", product: "replystack-pro-lifetime" }));
    const ok = await verifyLicense(token, [key.jwk], { productSlug: "replystack-pro, replystack-pro-lifetime, replystack-business" });
    expect(ok).toEqual(expect.objectContaining({ valid: true }));
    const no = await verifyLicense(token, [key.jwk], { productSlug: "replystack-pro,replystack-business" });
    expect(no).toEqual({ valid: false, reason: "wrong_product" });
  });

  it("treats a null exp as a non-expiring token", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", exp: null }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT });
    expect(res).toEqual(expect.objectContaining({ valid: true }));
  });

  // ── per-domain binding ──────────────────────────────────────────────────────────────────────
  // A token may carry a `domain` claim binding it to one buyer's domain. When present it is honoured
  // only on that domain and its subdomains (Policy A: 1 purchase = 1 customer's whole domain). A
  // token WITHOUT a domain claim is unbound (back-compat: legacy tokens, dev, e2e keep working).

  it("accepts a domain-bound token on its own domain", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", domain: "example.com" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "example.com" });
    expect(res).toEqual(expect.objectContaining({ valid: true, tier: "pro" }));
  });

  it("accepts a domain-bound token on a subdomain of its domain", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", domain: "example.com" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "replystack.example.com" });
    expect(res).toEqual(expect.objectContaining({ valid: true }));
  });

  it("rejects a domain-bound token on a different domain", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", domain: "example.com" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "evil.com" });
    expect(res).toEqual({ valid: false, reason: "wrong_domain" });
  });

  it("rejects a domain-bound token when the instance host is unknown (fail closed)", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", domain: "example.com" }));
    expect(await verifyLicense(token, [key.jwk], { productSlug: PRODUCT })).toEqual({ valid: false, reason: "wrong_domain" });
    expect(await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "" })).toEqual({ valid: false, reason: "wrong_domain" });
  });

  it("ignores the host for an UNBOUND token (no domain claim) — back-compat", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1" })); // no domain
    expect(await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "anything.com" })).toEqual(
      expect.objectContaining({ valid: true }),
    );
    expect(await verifyLicense(token, [key.jwk], { productSlug: PRODUCT })).toEqual(expect.objectContaining({ valid: true }));
  });

  it("normalizes host case / port / www before matching the domain claim", async () => {
    const token = await key.sign(makeClaims({ kid: "kid-1", domain: "example.com" }));
    const res = await verifyLicense(token, [key.jwk], { productSlug: PRODUCT, expectedHost: "WWW.Example.COM:3000" });
    expect(res).toEqual(expect.objectContaining({ valid: true }));
  });
});

describe("domainMatches", () => {
  it("matches the exact domain and strips leading www", () => {
    expect(domainMatches("example.com", "example.com")).toBe(true);
    expect(domainMatches("example.com", "www.example.com")).toBe(true);
    expect(domainMatches("www.example.com", "example.com")).toBe(true);
  });

  it("matches any subdomain of the licensed domain (Policy A)", () => {
    expect(domainMatches("example.com", "app.example.com")).toBe(true);
    expect(domainMatches("example.com", "replystack.example.com")).toBe(true);
    expect(domainMatches("example.com", "a.b.example.com")).toBe(true);
  });

  it("treats an explicit *. prefix the same as the bare domain", () => {
    expect(domainMatches("*.example.com", "app.example.com")).toBe(true);
    expect(domainMatches("*.example.com", "example.com")).toBe(true);
  });

  it("does NOT match unrelated or look-alike domains (dot boundary)", () => {
    expect(domainMatches("example.com", "example.org")).toBe(false);
    expect(domainMatches("example.com", "notexample.com")).toBe(false);
    expect(domainMatches("example.com", "badexample.com")).toBe(false);
    expect(domainMatches("example.com", "example.com.evil.com")).toBe(false);
  });

  it("a subdomain license does NOT match the apex", () => {
    expect(domainMatches("app.example.com", "app.example.com")).toBe(true);
    expect(domainMatches("app.example.com", "example.com")).toBe(false);
  });

  it("is case-insensitive and port-insensitive", () => {
    expect(domainMatches("Example.COM", "APP.Example.com:8080")).toBe(true);
  });

  it("returns false for empty inputs", () => {
    expect(domainMatches("example.com", "")).toBe(false);
    expect(domainMatches("", "example.com")).toBe(false);
  });
});

describe("hostFromUrl", () => {
  it("extracts the lowercased hostname from a URL", () => {
    expect(hostFromUrl("https://App.Example.com/x")).toBe("app.example.com");
    expect(hostFromUrl("https://app.example.com:3000/x?y=1")).toBe("app.example.com");
  });

  it("falls back to a bare domain string", () => {
    expect(hostFromUrl("example.com")).toBe("example.com");
  });

  it("returns null for non-URL, non-domain junk", () => {
    expect(hostFromUrl("not a url")).toBeNull();
    expect(hostFromUrl("")).toBeNull();
  });
});
