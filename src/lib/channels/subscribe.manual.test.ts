import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// A8: a MANUAL "Fix"/"Re-apply" of the IG-Login messaging subscription must NOT degrade or alert a
// currently-healthy channel on a transient failure. Only the AUTO OAuth-callback path degrades/alerts.
// Unit-level: mock the provider (subscribe outcome), db, alert and health seams.

const subscribeMessagingWebhooks = vi.fn(async (_tok: string, _id: string) => false);
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({ subscribeMessagingWebhooks: (tok: string, id: string) => subscribeMessagingWebhooks(tok, id) }),
}));

const findFirst = vi.fn();
const update = vi.fn((_arg?: unknown) => ({ set: () => ({ where: async () => {} }) }));
vi.mock("@/lib/db", () => ({
  db: { query: { channels: { findFirst: (arg: unknown) => findFirst(arg) } }, update: (arg: unknown) => update(arg) },
}));

const markChannelNeedsReauth = vi.fn(async () => {});
vi.mock("./health", () => ({ markChannelNeedsReauth: () => markChannelNeedsReauth() }));

const dispatchAlert = vi.fn(async () => {});
vi.mock("@/lib/notifications/alert", () => ({ dispatchAlert: () => dispatchAlert() }));

let subscribeInstagramMessaging: typeof import("./subscribe").subscribeInstagramMessaging;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://x:x@localhost:5432/x";
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
  process.env.APP_URL ??= "http://localhost:3000";
  process.env.META_APP_ID ??= "ci-app-id";
  process.env.META_APP_SECRET ??= "ci-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "ci-verify";
  process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";
  ({ subscribeInstagramMessaging } = await import("./subscribe"));
});

beforeEach(() => {
  subscribeMessagingWebhooks.mockReset().mockResolvedValue(false);
  findFirst.mockReset();
  update.mockClear();
  markChannelNeedsReauth.mockClear();
  dispatchAlert.mockClear();
});

describe("subscribeInstagramMessaging — manual re-apply (A8)", () => {
  it("manual=true + subscribe FAILS → returns {ok:false}, does NOT degrade/alert/touch the channel", async () => {
    const r = await subscribeInstagramMessaging("ws_1", "IGID", "IGQW", { manual: true });
    expect(r).toEqual({ ok: false });
    // Never reads/writes channel state, never flips status, never alerts.
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(markChannelNeedsReauth).not.toHaveBeenCalled();
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it("manual=true + subscribe SUCCEEDS → returns {ok:true}", async () => {
    subscribeMessagingWebhooks.mockResolvedValue(true);
    const r = await subscribeInstagramMessaging("ws_1", "IGID", "IGQW", { manual: true });
    expect(r).toEqual({ ok: true });
    expect(markChannelNeedsReauth).not.toHaveBeenCalled();
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it("AUTO path (no opts) + IG-Login-only failure → still flips needs_reauth (unchanged behavior)", async () => {
    // IG-Login-only: no FB access_token / page_id → degraded to needs_reauth on failure.
    const { encryptTokens } = await import("@/lib/crypto");
    findFirst.mockResolvedValueOnce({
      id: "ch_1",
      token_encrypted: encryptTokens({ access_token: "", messaging_token: "IGQW" }),
      last_error: null,
      display_name: "ig",
    });
    const r = await subscribeInstagramMessaging("ws_1", "IGID", "IGQW");
    expect(r).toEqual({ ok: false });
    expect(markChannelNeedsReauth).toHaveBeenCalled();
  });
});
