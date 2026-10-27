import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const WS = randomUUID(), OTHER_WS = randomUUID(), CHANNEL = randomUUID(), FOREIGN = randomUUID(), USER = randomUUID();
const KEY = "sk_live_creator_info_test_key", WRONG_KEY = "sk_live_creator_info_wrong_scope";
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let app: ReturnType<typeof import("@/server/app").buildApp>;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let cookie: string;
const info = {
  creator_nickname: "Creator", creator_avatar_url: "https://example.com/avatar", privacy_level_options: ["SELF_ONLY"],
  comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 300,
};
let fetchMock: ReturnType<typeof vi.fn>;
const path = (id = CHANNEL) => `/api/v1/channels/${id}/tiktok/creator-info`;
const read = (suffix = "", key = KEY) => app.request(path() + suffix, { headers: { authorization: `Bearer ${key}` } });

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.JWT_SECRET = "creator-info-test-secret-at-least-32-chars";
  process.env.ENCRYPTION_KEY = "creator-info-encryption-at-least-32-chars";
  process.env.CRON_SECRET = "creator-info-cron-secret-at-least-32-chars";
  process.env.APP_URL = "http://localhost:3000";
  ({ db } = await import("@/lib/db")); s = await import("@/db/schema");
  ({ encryptTokens } = await import("@/lib/crypto"));
  const { signSession } = await import("@/lib/auth");
  cookie = `session=${await signSession(USER, WS)}`;
  app = (await import("@/server/app")).buildApp();
  await db.insert(s.workspaces).values([{ id: WS, name: "Creator", slug: WS }, { id: OTHER_WS, name: "Other", slug: OTHER_WS }]);
  await db.insert(s.users).values({ id: USER, email: `${USER}@example.com`, password_hash: "unused" });
  await db.insert(s.workspaceMembers).values({ workspace_id: WS, user_id: USER, role: "owner" });
  await db.insert(s.apiKeys).values([KEY, WRONG_KEY].map((key) => ({
    workspace_id: WS, name: key, key_prefix: "sk_live_cr", key_hash: createHash("sha256").update(key).digest("hex"),
    scopes: key === KEY ? ["channels:read"] : ["contacts:read"],
  })));
});
beforeEach(async () => {
  await db.delete(s.channels).where(eq(s.channels.workspace_id, WS));
  await db.delete(s.channels).where(eq(s.channels.workspace_id, OTHER_WS));
  await db.insert(s.channels).values([
    { id: CHANNEL, workspace_id: WS, platform: "tiktok", platform_id: "creator", token_encrypted: encryptTokens({ access_token: "test-token" }), webhook_secret: "unused" },
    { id: FOREIGN, workspace_id: OTHER_WS, platform: "tiktok", platform_id: "other", token_encrypted: encryptTokens({ access_token: "other-token" }), webhook_secret: "unused" },
  ]);
  fetchMock = vi.fn().mockImplementation(async () => Response.json({ data: info, error: { code: "ok" } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => {
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, OTHER_WS));
  await db.delete(s.users).where(eq(s.users.id, USER));
});
async function updateChannel(values: Partial<typeof s.channels.$inferInsert>) {
  await db.update(s.channels).set(values).where(and(eq(s.channels.id, CHANNEL), eq(s.channels.workspace_id, WS)));
}

describe("TikTok creator-info routes", () => {
  it("returns creator info and reuses a channel cache", async () => {
    expect(await (await read()).json()).toEqual({ data: { status: "available", creator_info: info }, error: null });
    expect((await read()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("forces refresh and replaces cached permissions", async () => {
    await read();
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "spam_risk_too_many_posts" } }));
    const res = await read("?refresh=true");
    expect((await res.json()).data).toMatchObject({ status: "cannot_post_now", reason: "spam_risk_too_many_posts" });
    expect((await (await read()).json()).data.status).toBe("cannot_post_now");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("expires cached data after 60 seconds", async () => {
    await read();
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    await read(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("uses new credentials after reconnect", async () => {
    await read(); await updateChannel({ token_encrypted: encryptTokens({ access_token: "new-token" }) });
    await read(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new-token");
  });
  it("rejects absent auth and incorrect scopes", async () => {
    expect((await app.request(path())).status).toBe(401);
    expect((await read("", WRONG_KEY)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns 404 for another workspace and unknown channels", async () => {
    for (const id of [FOREIGN, randomUUID()]) {
      expect((await app.request(path(id), { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("checks platform before using cached data", async () => {
    await read(); await updateChannel({ platform: "youtube" });
    expect((await read()).status).toBe(400); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("returns reconnect guidance for unreadable credentials", async () => {
    await updateChannel({ token_encrypted: "invalid" });
    expect((await read()).status).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not reuse old data after a failed refresh", async () => {
    await read(); fetchMock.mockImplementation(async () => Response.json({ error: { code: "access_token_invalid", message: "test-token" } }, { status: 401 }));
    const res = await read("?refresh=true");
    expect(res.status).toBe(400); expect(await res.text()).not.toContain("test-token");
    expect((await read()).status).toBe(400); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("validates the refresh parameter", async () => {
    expect((await read("?refresh=maybe")).status).toBe(400); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("serves the session-only dashboard endpoint", async () => {
    const url = `/channels/${CHANNEL}/tiktok/creator-info`;
    const res = await app.request(url, { headers: { cookie } });
    expect(res.status).toBe(200); expect((await res.json()).data.creator_info).toEqual(info);
    const keyRes = await app.request(url, { headers: { authorization: `Bearer ${KEY}` } });
    expect([302, 401]).toContain(keyRes.status);
  });
});
