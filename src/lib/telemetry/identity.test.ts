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
