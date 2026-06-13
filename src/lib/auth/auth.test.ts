import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

describe("generateApiKey", () => {
  it("returns plaintext starting with the brand-neutral idPrefix (sk_live_)", async () => {
    const { generateApiKey } = await import("./index");
    const { BRAND } = await import("@/lib/brand");
    const { plaintext } = generateApiKey();
    expect(BRAND.idPrefix).toBe("sk_live_");
    expect(plaintext.startsWith(BRAND.idPrefix)).toBe(true);
  });

  it("prefix is first 16 chars of plaintext", async () => {
    const { generateApiKey } = await import("./index");
    const { plaintext, prefix } = generateApiKey();
    expect(plaintext.slice(0, 16)).toBe(prefix);
  });

  it("hash is sha256 of plaintext", async () => {
    const { generateApiKey } = await import("./index");
    const { createHash } = await import("crypto");
    const { plaintext, hash } = generateApiKey();
    const expected = createHash("sha256").update(plaintext).digest("hex");
    expect(hash).toBe(expected);
  });

  it("two calls produce different keys", async () => {
    const { generateApiKey } = await import("./index");
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifies correct password", async () => {
    const { hashPassword, verifyPassword } = await import("./password");
    const hash = await hashPassword("correcthorsebatterystaple");
    expect(await verifyPassword("correcthorsebatterystaple", hash)).toBe(true);
  });

  it("rejects wrong password", async () => {
    const { hashPassword, verifyPassword } = await import("./password");
    const hash = await hashPassword("correct");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces different hashes for same password (random salt)", async () => {
    const { hashPassword } = await import("./password");
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });
});
