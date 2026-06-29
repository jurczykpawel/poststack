import { describe, it, expect, beforeAll } from "vitest";

// token-refresh.ts imports @/lib/db (throws at module load without DATABASE_URL) and crypto (needs
// ENCRYPTION_KEY). Set both before the (dynamic) import — no real DB connection is made at import time.
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";

import type { TokenSet } from "@/lib/providers/types";

let mergeRefreshedBlob: typeof import("./token-refresh").mergeRefreshedBlob;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let decryptTokens: typeof import("@/lib/crypto").decryptTokens;

beforeAll(async () => {
  ({ mergeRefreshedBlob } = await import("./token-refresh"));
  ({ encryptTokens, decryptTokens } = await import("@/lib/crypto"));
});

describe("A7: token-refresh persist preserves non-credential blob fields", () => {
  it("overlays only the refreshed credential fields onto the current blob (keeps messaging_token + page_id + user_access_token)", () => {
    const currentBlob = {
      access_token: "old-fb-page-tok",
      refresh_token: "old-refresh",
      expires_at: 1000,
      messaging_token: "IGQW_messaging_tok",
      messaging_token_expires_at: 9999,
      page_id: "PG_123",
      user_access_token: "USER_TOK",
    };
    const refreshed: TokenSet = {
      accessToken: "new-fb-page-tok",
      refreshToken: "old-refresh",
      expiresAt: new Date(2_000_000 * 1000).toISOString(),
    };

    const newBlob = mergeRefreshedBlob(currentBlob, refreshed);

    // refreshed credential fields applied
    expect(newBlob.access_token).toBe("new-fb-page-tok");
    expect(newBlob.expires_at).toBe(2_000_000);
    // non-credential blob fields PRESERVED (the bug: they were being dropped)
    expect(newBlob.messaging_token).toBe("IGQW_messaging_tok");
    expect(newBlob.messaging_token_expires_at).toBe(9999);
    expect(newBlob.page_id).toBe("PG_123");
    expect(newBlob.user_access_token).toBe("USER_TOK");
  });

  it("preserves the existing refresh_token when the refreshed set carries none", () => {
    const currentBlob = { access_token: "a", refresh_token: "keep-me", page_id: "PG" };
    const refreshed: TokenSet = { accessToken: "b" }; // no refreshToken
    const newBlob = mergeRefreshedBlob(currentBlob, refreshed);
    expect(newBlob.refresh_token).toBe("keep-me");
    expect(newBlob.page_id).toBe("PG");
  });

  it("the persisted (encrypt→decrypt) blob still carries messaging_token + page_id and the NEW access_token", () => {
    const currentBlob = { access_token: "old", messaging_token: "IGQW", page_id: "PG" };
    const refreshed: TokenSet = { accessToken: "new", expiresAt: new Date(123_456 * 1000).toISOString() };

    const persisted = decryptTokens(encryptTokens(mergeRefreshedBlob(currentBlob, refreshed)));

    expect(persisted.access_token).toBe("new");
    expect(persisted.messaging_token).toBe("IGQW");
    expect(persisted.page_id).toBe("PG");
  });
});
