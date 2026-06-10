import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

//  — on a send/refresh path a decrypt FAILURE (corrupt token / rotated TOKEN_ENCRYPTION_KEY)
// must surface as a re-auth case, not a generic throw that crash-loops to the dead-letter queue
// without ever flagging the channel needs_reauth.
describe("decryptChannelToken", () => {
  it("returns the token data for a good ciphertext (round-trip)", async () => {
    const { encryptTokens } = await import("@/lib/crypto");
    const { decryptChannelToken } = await import("./tokens");
    const data = { access_token: "abc123", expires_at: 9999999 };
    expect(decryptChannelToken(encryptTokens(data))).toEqual(data);
  });

  it("throws TokenInvalidError on a tampered/undecryptable token", async () => {
    const { encryptTokens } = await import("@/lib/crypto");
    const { decryptChannelToken } = await import("./tokens");
    const { TokenInvalidError } = await import("@/lib/platforms/errors");
    const parts = encryptTokens({ access_token: "token" }).split(":");
    parts[2] = "deadbeef"; // corrupt ciphertext (GCM auth-tag mismatch)
    expect(() => decryptChannelToken(parts.join(":"))).toThrow(TokenInvalidError);
  });

  it("throws TokenInvalidError on a malformed token (wrong key / format)", async () => {
    const { decryptChannelToken } = await import("./tokens");
    const { TokenInvalidError } = await import("@/lib/platforms/errors");
    expect(() => decryptChannelToken("not:valid")).toThrow(TokenInvalidError);
  });
});
