import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// reconcileChannelSubscription routes an IG-Login-only channel (messaging_token, no page_id) to the
// per-account re-subscribe (subscribeInstagramMessaging on graph.instagram.com), NOT subscribePageWebhooks.

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findFirst: (arg: unknown) => findFirst(arg) } } },
}));

const subscribeInstagramMessaging = vi.fn(async (_ws: string, _id: string, _tok: string) => ({ ok: true }));
vi.mock("./subscribe", () => ({
  subscribeInstagramMessaging: (ws: string, id: string, tok: string) => subscribeInstagramMessaging(ws, id, tok),
}));

const subscribePageWebhooks = vi.fn(async (_pageId: string, _tok: string) => true);
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({ subscribePageWebhooks: (pageId: string, tok: string) => subscribePageWebhooks(pageId, tok) }),
}));

let reconcileChannelSubscription: typeof import("./subscription-status").reconcileChannelSubscription;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://x:x@localhost:5432/x";
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.META_APP_ID ??= "ci-app-id";
  process.env.META_APP_SECRET ??= "ci-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "ci-verify";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ reconcileChannelSubscription } = await import("./subscription-status"));
});

beforeEach(() => {
  findFirst.mockReset();
  subscribeInstagramMessaging.mockClear();
  subscribePageWebhooks.mockClear();
});

describe("reconcileChannelSubscription (E2 re-subscribe routing)", () => {
  it("IG-Login-only → calls subscribeInstagramMessaging, NOT subscribePageWebhooks", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_1",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }), // no page_id
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_1");
    expect(ok).toBe(true);
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_1", "IGQW");
    expect(subscribePageWebhooks).not.toHaveBeenCalled();
  });

  it("DUAL channel (page_id + messaging_token) → re-applies BOTH, true only if both succeed", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_2",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG_2", messaging_token: "IGQW" }),
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_3");
    expect(ok).toBe(true);
    expect(subscribePageWebhooks).toHaveBeenCalledWith("PG_2", "FB");
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_2", "IGQW");
  });

  it("DUAL channel → false when the IG-Login subscribe fails (even if page succeeds)", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_3",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG_3", messaging_token: "IGQW" }),
    });
    subscribeInstagramMessaging.mockResolvedValueOnce({ ok: false });
    const ok = await reconcileChannelSubscription("ws_1", "ch_4");
    expect(ok).toBe(false);
    expect(subscribePageWebhooks).toHaveBeenCalledWith("PG_3", "FB");
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_3", "IGQW");
  });

  it("page-backed channel → still uses subscribePageWebhooks", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "facebook",
      platform_id: "PAGE_1",
      token_encrypted: encryptTokens({ access_token: "T" }),
    });
    await reconcileChannelSubscription("ws_1", "ch_2");
    expect(subscribePageWebhooks).toHaveBeenCalled();
    expect(subscribeInstagramMessaging).not.toHaveBeenCalled();
  });
});
