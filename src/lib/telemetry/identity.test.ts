import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { domainHash, licenseHash } from "./identity";
import { TELEMETRY_HASH_PEPPER } from "./constants";

// Pure (no DB) — the deterministic identifiers an instance reports without revealing its
// actual domain or license order id (one-way sha256 over a fixed pepper).

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("domainHash", () => {
  it("is a hex sha256 of pepper + lowercased hostname", () => {
    expect(domainHash("https://app.example.com")).toBe(
      sha256Hex(TELEMETRY_HASH_PEPPER + "app.example.com"),
    );
  });

  it("is deterministic for the same host", () => {
    expect(domainHash("https://app.example.com")).toBe(domainHash("https://app.example.com"));
  });

  it("differs for a different host", () => {
    expect(domainHash("https://a.example.com")).not.toBe(domainHash("https://b.example.com"));
  });

  it("strips the port", () => {
    expect(domainHash("https://app.example.com:8443")).toBe(domainHash("https://app.example.com"));
  });

  it("is case-insensitive on the host", () => {
    expect(domainHash("https://APP.Example.COM")).toBe(domainHash("https://app.example.com"));
  });

  it("uses the full hostname (no public-suffix folding)", () => {
    expect(domainHash("https://a.example.com")).not.toBe(domainHash("https://example.com"));
  });
});

describe("licenseHash", () => {
  it("is a hex sha256 of pepper + order", () => {
    expect(licenseHash("ord_123")).toBe(sha256Hex(TELEMETRY_HASH_PEPPER + "ord_123"));
  });

  it("is deterministic for the same order", () => {
    expect(licenseHash("ord_123")).toBe(licenseHash("ord_123"));
  });

  it("differs for a different order", () => {
    expect(licenseHash("ord_123")).not.toBe(licenseHash("ord_456"));
  });
});

// Frozen vectors — these break loudly if TELEMETRY_HASH_PEPPER or the hash algorithm ever changes.
// The receiver pins the SAME `order-test-vector-001` value, so both sides must agree byte-for-byte.
describe("hash test vectors (frozen)", () => {
  it("licenseHash of the canonical vector matches the pinned hex", () => {
    expect(licenseHash("order-test-vector-001")).toBe(
      "74633b0958d059f172c39ffcc50aa3662d6af817700db5c923bea5b0f79034f2",
    );
  });

  it("domainHash of https://example.com matches the pinned hex", () => {
    expect(domainHash("https://example.com")).toBe(
      "f261dc3fdda379dfcff088f91d9c0ec7ccfc8b6abc37d42671c551733dee5057",
    );
  });
});
