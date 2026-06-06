import { describe, it, expect, beforeAll } from "vitest";

// Set required env before importing module
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

describe("encryptTokens / decryptTokens", () => {
  it("round-trips token data", async () => {
    const { encryptTokens, decryptTokens } = await import("./crypto");
    const data = { access_token: "abc123", refresh_token: "xyz", expires_at: 9999999 };
    const encrypted = encryptTokens(data);
    const decrypted = decryptTokens(encrypted);
    expect(decrypted).toEqual(data);
  });

  it("produces different ciphertext for same plaintext (random IV)", async () => {
    const { encryptTokens } = await import("./crypto");
    const data = { access_token: "same" };
    expect(encryptTokens(data)).not.toBe(encryptTokens(data));
  });

  it("throws on tampered ciphertext", async () => {
    const { encryptTokens, decryptTokens } = await import("./crypto");
    const encrypted = encryptTokens({ access_token: "token" });
    const parts = encrypted.split(":");
    parts[2] = "deadbeef"; // corrupt ciphertext
    expect(() => decryptTokens(parts.join(":"))).toThrow();
  });

  it("throws on malformed input", async () => {
    const { decryptTokens } = await import("./crypto");
    expect(() => decryptTokens("not:valid")).toThrow("Invalid encrypted token format");
  });
});

describe("verifyMetaSignature", () => {
  it("accepts a valid signature", async () => {
    const { verifyMetaSignature } = await import("./crypto");
    const { createHmac } = await import("crypto");
    const body = '{"object":"page"}';
    const secret = "my-app-secret";
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
  });

  it("rejects an invalid signature", async () => {
    const { verifyMetaSignature } = await import("./crypto");
    expect(verifyMetaSignature("body", "sha256=badhash", "secret")).toBe(false);
  });

  it("rejects null signature", async () => {
    const { verifyMetaSignature } = await import("./crypto");
    expect(verifyMetaSignature("body", null, "secret")).toBe(false);
  });
});
