import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// env is validated + frozen at import, so set META_APP_ID/SECRET before importing the
// module under test, then mock fetch per case to stand in for the Graph /debug_token response.
let assertMetaTokenBelongsToApp: typeof import("./meta-token").assertMetaTokenBelongsToApp;
const realFetch = globalThis.fetch;

function mockDebug(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as typeof fetch;
}

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  process.env.META_APP_ID = "111";
  process.env.META_APP_SECRET = "sec";
  ({ assertMetaTokenBelongsToApp } = await import("./meta-token"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("assertMetaTokenBelongsToApp", () => {
  it("rejects a token minted by a DIFFERENT app", async () => {
    mockDebug({ data: { app_id: "999", is_valid: true } });
    await expect(assertMetaTokenBelongsToApp("tok")).rejects.toThrow(/different Facebook app/);
  });

  it("rejects an invalid/expired token", async () => {
    mockDebug({ data: { app_id: "111", is_valid: false } });
    await expect(assertMetaTokenBelongsToApp("tok")).rejects.toThrow(/invalid or expired/);
  });

  it("accepts a valid token for THIS app", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true } });
    await expect(assertMetaTokenBelongsToApp("tok")).resolves.toBeUndefined();
  });

  it("does not block connect when debug_token itself fails (transient Meta-side)", async () => {
    mockDebug({ error: { message: "boom" } }, 500);
    await expect(assertMetaTokenBelongsToApp("tok")).resolves.toBeUndefined();
  });
});
