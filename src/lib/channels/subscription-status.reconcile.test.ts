import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// reconcileChannelSubscription routes an IG-Login-only channel (messaging_token, no page_id) to the
// per-account re-subscribe (subscribeInstagramMessaging on graph.instagram.com), NOT subscribePageWebhooks.

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findFirst: (arg: unknown) => findFirst(arg) } } },
}));

// The subscription-failure markers reconcile reads to decide whether a successful re-apply may close
// the breaker. Mirror the real exported values from ./subscribe so the gate compares like-for-like.
const SUBSCRIBE_FAILED_ERROR = "Webhook subscription failed — no inbound events until re-subscribed";
const MESSAGING_SUBSCRIBE_FAILED_REASON = "messaging_webhook_subscribe_failed";
const MESSAGING_SUBSCRIBE_FAILED_FB_WARNING =
  "IG messaging webhook subscribe failed — IG DM receipt not guaranteed at Standard Access; reconnect via Instagram Login";

const subscribeInstagramMessaging = vi.fn(async (_ws: string, _id: string, _tok: string, _opts?: { manual?: boolean }) => ({ ok: true }));
vi.mock("./subscribe", () => ({
  subscribeInstagramMessaging: (ws: string, id: string, tok: string, opts?: { manual?: boolean }) =>
    subscribeInstagramMessaging(ws, id, tok, opts),
  SUBSCRIBE_FAILED_ERROR,
  MESSAGING_SUBSCRIBE_FAILED_REASON,
  MESSAGING_SUBSCRIBE_FAILED_FB_WARNING,
}));

const markChannelHealthy = vi.fn(async (_id: string) => {});
vi.mock("./health", () => ({
  markChannelHealthy: (id: string) => markChannelHealthy(id),
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
  markChannelHealthy.mockClear();
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
    // A8: a reconcile-driven re-subscribe is a manual "Fix"/"Re-apply" → must pass { manual: true }
    // so a transient failure can't degrade/alert a currently-healthy channel.
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_1", "IGQW", { manual: true });
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
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_2", "IGQW", { manual: true });
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
    expect(subscribeInstagramMessaging).toHaveBeenCalledWith("ws_1", "IGID_3", "IGQW", { manual: true });
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

describe("reconcileChannelSubscription (A4 — successful Fix closes a subscription-caused breaker)", () => {
  it("needs_reauth IG-Login-only (subscription-failure reason) → success → markChannelHealthy IS called", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_A4",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }),
      status: "needs_reauth",
      last_error: MESSAGING_SUBSCRIBE_FAILED_REASON,
      needs_reauth_reason: MESSAGING_SUBSCRIBE_FAILED_REASON,
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_a4");
    expect(ok).toBe(true);
    expect(markChannelHealthy).toHaveBeenCalledWith("ch_a4");
  });

  it("active FB-backed channel carrying the IG-DM warning last_error → success → breaker cleared", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_A4b",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG", messaging_token: "IGQW" }),
      status: "active",
      last_error: MESSAGING_SUBSCRIBE_FAILED_FB_WARNING,
      needs_reauth_reason: null,
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_a4b");
    expect(ok).toBe(true);
    expect(markChannelHealthy).toHaveBeenCalledWith("ch_a4b");
  });

  it("needs_reauth from a TOKEN-death reason → success → markChannelHealthy NOT called (gated)", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_A4c",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }),
      status: "needs_reauth",
      last_error: "This access token is invalid or expired.",
      needs_reauth_reason: "This access token is invalid or expired.",
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_a4c");
    expect(ok).toBe(true);
    expect(markChannelHealthy).not.toHaveBeenCalled();
  });

  it("healthy channel (active, no last_error) → success → markChannelHealthy NOT called", async () => {
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_A4d",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }),
      status: "active",
      last_error: null,
      needs_reauth_reason: null,
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_a4d");
    expect(ok).toBe(true);
    expect(markChannelHealthy).not.toHaveBeenCalled();
  });

  it("subscription FAILS → breaker NOT closed even if it was a subscription-caused failure", async () => {
    subscribeInstagramMessaging.mockResolvedValueOnce({ ok: false });
    findFirst.mockResolvedValueOnce({
      platform: "instagram",
      platform_id: "IGID_A4e",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }),
      status: "needs_reauth",
      last_error: MESSAGING_SUBSCRIBE_FAILED_REASON,
      needs_reauth_reason: MESSAGING_SUBSCRIBE_FAILED_REASON,
    });
    const ok = await reconcileChannelSubscription("ws_1", "ch_a4e");
    expect(ok).toBe(false);
    expect(markChannelHealthy).not.toHaveBeenCalled();
  });
});
