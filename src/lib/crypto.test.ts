import { describe, it, expect, beforeAll } from "vitest";

// Set required env before importing module. The encryption key is now ENCRYPTION_KEY: any
// passphrase >= 32 chars (sha256-derived to 32 bytes), not a 64-char hex string.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

describe("requireEncryptionKey", () => {
  it("returns the key when set and long enough", async () => {
    const { requireEncryptionKey } = await import("./crypto");
    expect(requireEncryptionKey()).toBe(process.env.ENCRYPTION_KEY);
  });

  it("throws when ENCRYPTION_KEY is missing", async () => {
    const { requireEncryptionKey } = await import("./crypto");
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => requireEncryptionKey()).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });

  it("throws when ENCRYPTION_KEY is shorter than 32 chars", async () => {
    const { requireEncryptionKey } = await import("./crypto");
    const saved = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = "too-short";
    try {
      expect(() => requireEncryptionKey()).toThrow(/ENCRYPTION_KEY/);
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });
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

  it("rejects a tampered same-length signature", async () => {
    const { verifyMetaSignature } = await import("./crypto");
    const { createHmac } = await import("crypto");
    const body = '{"object":"page"}';
    const secret = "my-app-secret";
    const valid = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    // Flip one hex char so the candidate keeps the SAME .length but mismatches.
    const last = valid.slice(-1);
    const tampered = valid.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(tampered.length).toBe(valid.length);
    expect(verifyMetaSignature(body, tampered, secret)).toBe(false);
  });

  it("does not throw on a multibyte signature with equal UTF-16 length but larger byte length [A11]", async () => {
    const { verifyMetaSignature } = await import("./crypto");
    const { createHmac } = await import("crypto");
    const body = '{"object":"page"}';
    const secret = "my-app-secret";
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    // Build a signature whose .length equals expected.length but contains a multibyte char,
    // so Buffer.from(signature).length > Buffer.from(expected).length.
    const multibyteSig = expected.slice(0, -1) + "é"; // same UTF-16 length, +1 byte
    expect(multibyteSig.length).toBe(expected.length);
    expect(Buffer.from(multibyteSig).length).toBeGreaterThan(Buffer.from(expected).length);
    expect(() => verifyMetaSignature(body, multibyteSig, secret)).not.toThrow();
    expect(verifyMetaSignature(body, multibyteSig, secret)).toBe(false);
  });
});
