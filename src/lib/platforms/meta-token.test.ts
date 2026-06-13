import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// env is validated + frozen at import, so set META_APP_ID/SECRET before importing the
// module under test, then mock fetch per case to stand in for the Graph /debug_token response.
let mod: typeof import("./meta-token");
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
  mod = await import("./meta-token");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("assertMetaTokenBelongsToApp", () => {
  it("rejects a token minted by a DIFFERENT app", async () => {
    mockDebug({ data: { app_id: "999", is_valid: true } });
    await expect(mod.assertMetaTokenBelongsToApp("tok")).rejects.toThrow(/different Facebook app/);
  });

  it("rejects an invalid/expired token", async () => {
    mockDebug({ data: { app_id: "111", is_valid: false } });
    await expect(mod.assertMetaTokenBelongsToApp("tok")).rejects.toThrow(/invalid or expired/);
  });

  it("accepts a valid token for THIS app", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true } });
    await expect(mod.assertMetaTokenBelongsToApp("tok")).resolves.toBeUndefined();
  });

  it("does not block connect when debug_token itself fails (transient Meta-side)", async () => {
    mockDebug({ error: { message: "boom" } }, 500);
    await expect(mod.assertMetaTokenBelongsToApp("tok")).resolves.toBeUndefined();
  });

  it("throws a MetaTokenError (a specific, surfaceable reason)", async () => {
    mockDebug({ data: { app_id: "999", is_valid: true } });
    await expect(mod.assertMetaTokenBelongsToApp("tok")).rejects.toBeInstanceOf(mod.MetaTokenError);
  });
});

describe("inspectMetaToken — classify token kind (the two clocks)", () => {
  it("classifies a PAGE token by type, with its page id", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true, type: "PAGE", profile_id: "PAGE123", data_access_expires_at: 1893456000 } });
    const info = await mod.inspectMetaToken("tok");
    expect(info?.kind).toBe("page");
    expect(info?.profileId).toBe("PAGE123");
  });

  it("classifies a long-lived USER token (has both clocks) as user", async () => {
    const future = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;
    mockDebug({ data: { app_id: "111", is_valid: true, type: "USER", expires_at: future, data_access_expires_at: future } });
    const info = await mod.inspectMetaToken("tok");
    expect(info?.kind).toBe("user");
    expect(info?.expiresAt).toBe(future);
    expect(info?.dataAccessExpiresAt).toBe(future);
  });

  it("classifies a System User token (USER type, NO expiry, NO data wall) as system_user", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true, type: "USER", expires_at: 0, data_access_expires_at: 0 } });
    const info = await mod.inspectMetaToken("tok");
    expect(info?.kind).toBe("system_user");
    expect(info?.expiresAt).toBeUndefined();
    expect(info?.dataAccessExpiresAt).toBeUndefined();
  });

  it("normalizes Meta's 0 ('never') to undefined on both clocks", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true, type: "PAGE", expires_at: 0 } });
    const info = await mod.inspectMetaToken("tok");
    expect(info?.expiresAt).toBeUndefined();
  });

  it("captures granted scopes", async () => {
    mockDebug({ data: { app_id: "111", is_valid: true, type: "USER", expires_at: 999999999999, scopes: ["pages_show_list", "pages_messaging"] } });
    const info = await mod.inspectMetaToken("tok");
    expect(info?.scopes).toEqual(["pages_show_list", "pages_messaging"]);
  });

  it("returns null when app credentials make validation unrunnable (transient/404)", async () => {
    mockDebug("Not Found", 404);
    expect(await mod.inspectMetaToken("tok")).toBeNull();
  });
});

describe("assertMetaScopes", () => {
  function info(scopes: string[]): import("./meta-token").MetaTokenInfo {
    return { kind: "user", isValid: true, scopes };
  }

  it("throws a specific MetaTokenError naming the missing scope", () => {
    expect(() => mod.assertMetaScopes(info(["pages_show_list"]), ["pages_show_list", "pages_messaging"], "Facebook"))
      .toThrow(/pages_messaging/);
  });

  it("passes when all required scopes are present", () => {
    expect(() => mod.assertMetaScopes(info(["pages_show_list", "pages_messaging"]), ["pages_show_list", "pages_messaging"], "Facebook"))
      .not.toThrow();
  });

  it("is a no-op when scope info is unavailable (null or empty — don't block on missing data)", () => {
    expect(() => mod.assertMetaScopes(null, ["x"], "Facebook")).not.toThrow();
    expect(() => mod.assertMetaScopes(info([]), ["x"], "Facebook")).not.toThrow();
  });
});
