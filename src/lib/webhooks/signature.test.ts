import { describe, it, expect } from "vitest";
import { signWebhook, verifyWebhook } from "./signature";

describe("webhook HMAC (t=,v1=)", () => {
  const body = JSON.stringify({ hello: "world" });

  it("signs and verifies round-trip", () => {
    const header = signWebhook(["secret1"], 1000, body);
    expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook("secret1", header, body, { now: 1000 })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signWebhook(["secret1"], 1000, body);
    expect(verifyWebhook("secret1", header, body + "x", { now: 1000 })).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    const header = signWebhook(["secret1"], 1000, body);
    expect(verifyWebhook("secret1", header, body, { now: 1000 + 10_000, toleranceSec: 300 })).toBe(false);
  });

  it("accepts either secret during rotation", () => {
    const header = signWebhook(["primary", "secondary"], 1000, body);
    expect(verifyWebhook("secondary", header, body, { now: 1000 })).toBe(true);
    expect(verifyWebhook("primary", header, body, { now: 1000 })).toBe(true);
  });

  it("ignores an empty secondary secret (no rotation in progress)", () => {
    const header = signWebhook(["primary", ""], 1000, body);
    expect(header).toMatch(/^t=1000,v1=[0-9a-f]{64}$/); // only one v1=
    expect(verifyWebhook("primary", header, body, { now: 1000 })).toBe(true);
  });
});
