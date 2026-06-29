import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// A10: runHealthCheck must NOT validate an IG-Login-only channel's empty FB access_token. Such a
// channel has access_token "" and a messaging_token; its FB-token health is meaningless (and
// inspectMetaToken("") only returns null by luck). Its inbound health is owned by the messaging-token
// refresh worker. So: SKIP inspectMetaToken, markChannelHealthy, run the reconcile auto-config, and
// return "active". FB-only / dual channels (real access_token) keep validating via inspectMetaToken.

const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findFirst: (arg: unknown) => findFirst(arg) } } },
}));

const inspectMetaToken = vi.fn(async (_tok: string) => null);
class MetaTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaTokenError";
  }
}
vi.mock("@/lib/platforms/meta-token", () => ({
  inspectMetaToken: (tok: string) => inspectMetaToken(tok),
  MetaTokenError,
}));

const markChannelHealthy = vi.fn(async (_id: string) => {});
const markChannelNeedsReauth = vi.fn(async () => {});
vi.mock("@/lib/channels/health", () => ({
  markChannelHealthy: (id: string) => markChannelHealthy(id),
  markChannelNeedsReauth: () => markChannelNeedsReauth(),
}));

const reconcileChannelSubscription = vi.fn(async () => true);
vi.mock("@/lib/channels/subscription-status", () => ({
  reconcileChannelSubscription: () => reconcileChannelSubscription(),
  isSubscribablePlatform: (p: string) => p === "facebook" || p === "instagram",
}));

let runHealthCheck: typeof import("./service").runHealthCheck;
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
  ({ runHealthCheck } = await import("./service"));
});

beforeEach(() => {
  findFirst.mockReset();
  inspectMetaToken.mockReset().mockResolvedValue(null);
  markChannelHealthy.mockClear();
  markChannelNeedsReauth.mockClear();
  reconcileChannelSubscription.mockClear();
});

describe("runHealthCheck (A10 — skip empty FB token for IG-Login-only)", () => {
  it("IG-Login-only (empty access_token + messaging_token) → no inspectMetaToken, healthy + reconcile, returns active", async () => {
    findFirst.mockResolvedValueOnce({
      id: "ch_ig",
      platform: "instagram",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }), // no page_id
    });
    const res = await runHealthCheck("ws_1", "ch_ig");
    expect(res).toBe("active");
    expect(inspectMetaToken).not.toHaveBeenCalled();
    expect(markChannelHealthy).toHaveBeenCalledWith("ch_ig");
    expect(reconcileChannelSubscription).toHaveBeenCalled();
    expect(markChannelNeedsReauth).not.toHaveBeenCalled();
  });

  it("FB-backed channel (real access_token) → STILL validates via inspectMetaToken", async () => {
    findFirst.mockResolvedValueOnce({
      id: "ch_fb",
      platform: "facebook",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "REAL_TOKEN" }),
    });
    const res = await runHealthCheck("ws_1", "ch_fb");
    expect(res).toBe("active");
    expect(inspectMetaToken).toHaveBeenCalledWith("REAL_TOKEN");
    expect(markChannelHealthy).toHaveBeenCalledWith("ch_fb");
  });

  it("dual channel (FB token + messaging_token) → validates via inspectMetaToken (not treated as IG-Login-only)", async () => {
    findFirst.mockResolvedValueOnce({
      id: "ch_dual",
      platform: "instagram",
      status: "active",
      token_encrypted: encryptTokens({ access_token: "FB", page_id: "PG", messaging_token: "IGQW" }),
    });
    const res = await runHealthCheck("ws_1", "ch_dual");
    expect(res).toBe("active");
    expect(inspectMetaToken).toHaveBeenCalledWith("FB");
  });
});
