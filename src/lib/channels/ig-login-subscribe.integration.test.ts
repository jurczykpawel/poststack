import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

/**
 * IGFU2 + IGFU3 (real Postgres). After Instagram Business Login mints the IGQW token, the IG account
 * is subscribed to messaging webhooks the IG-Login-native way (per-account subscribed_apps). The
 * channel's status must reflect the REAL inbound capability:
 *   - subscribe OK on an IG-Login-only channel → stays "active" (truthful, it can receive).
 *   - subscribe FAILS on an IG-Login-only channel → "needs_reauth" + reason (never a silent "active").
 *   - a channel that ALSO has an FB page token still receives via the page subscription → never
 *     downgraded by an IG-Login subscribe failure (it just (re)subscribes per-account).
 */
// dispatchAlert delivers via safeFetchWebhook (node:http(s) pinned connector — NOT globalThis.fetch),
// so capture the dispatched alert bodies through this primitive rather than a global fetch stub.
const { safeFetchWebhookMock } = vi.hoisted(() => ({ safeFetchWebhookMock: vi.fn() }));
vi.mock("@/lib/webhooks/safe-target", async (orig) => {
  const actual = await orig<typeof import("@/lib/webhooks/safe-target")>();
  return { ...actual, safeFetchWebhook: safeFetchWebhookMock };
});

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let upsertChannels: typeof import("./upsert").upsertChannels;
let subscribeInstagramMessaging: typeof import("./subscribe").subscribeInstagramMessaging;
let InstagramProvider: typeof import("@/lib/platforms/instagram").InstagramProvider;
let encryptTokens: typeof import("@/lib/crypto").encryptTokens;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000d2";
const IG_ID = "17841400000999";
// Capture dispatchAlert POSTs (it posts to CHANNEL_ALERT_WEBHOOK_URL).
let alertBodies: Array<Record<string, unknown>>;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://example.com/alert-hook";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ upsertChannels } = await import("./upsert"));
  ({ subscribeInstagramMessaging } = await import("./subscribe"));
  ({ InstagramProvider } = await import("@/lib/platforms/instagram"));
  ({ encryptTokens } = await import("@/lib/crypto"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "U", slug: `u-${WS}` });
  vi.restoreAllMocks();
  // Intercept dispatchAlert's outbound delivery (so we can assert "alert fired", non-silently) without
  // a real network call. subscribeMessagingWebhooks is spied per-test, so it never hits this.
  alertBodies = [];
  safeFetchWebhookMock.mockReset();
  safeFetchWebhookMock.mockImplementation(async (_url: string, init: RequestInit) => {
    if (init?.body) alertBodies.push(JSON.parse(String(init.body)));
    return new Response("ok", { status: 200 });
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  vi.restoreAllMocks();
  if (closeQueue) await closeQueue();
});

function getChannel() {
  return db.query.channels.findFirst({
    where: and(eq(s.channels.workspace_id, WS), eq(s.channels.platform_id, IG_ID)),
  });
}

/** Create the minimal IG-Login-only channel exactly as the OAuth callback does (augment path, no
 *  pre-existing FB-login channel → empty access_token + messaging_token). */
async function createMinimalIgLoginChannel() {
  await upsertChannels(
    WS,
    "instagram",
    [{ platformId: IG_ID, displayName: "ig_only", username: "ig_only", tokens: { access_token: "" } }],
    { augmentMessagingToken: { token: "IGQW_TOK", expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) } },
  );
}

describe("subscribeInstagramMessaging (real Postgres)", () => {
  it("keeps an IG-Login-only channel active when the subscription succeeds", async () => {
    if (!TEST_DB) return;
    await createMinimalIgLoginChannel();
    expect((await getChannel())?.status).toBe("active");

    const spy = vi.spyOn(InstagramProvider.prototype, "subscribeMessagingWebhooks").mockResolvedValue(true);
    const r = await subscribeInstagramMessaging(WS, IG_ID, "IGQW_TOK");

    expect(spy).toHaveBeenCalledWith("IGQW_TOK", IG_ID);
    expect(r.ok).toBe(true);
    const c = await getChannel();
    expect(c?.status).toBe("active");
    expect(c?.needs_reauth_reason).toBeNull();
  });

  it("marks an IG-Login-only channel needs_reauth (with a reason) when the subscription fails", async () => {
    if (!TEST_DB) return;
    await createMinimalIgLoginChannel();

    vi.spyOn(InstagramProvider.prototype, "subscribeMessagingWebhooks").mockResolvedValue(false);
    const r = await subscribeInstagramMessaging(WS, IG_ID, "IGQW_TOK");

    expect(r.ok).toBe(false);
    const c = await getChannel();
    expect(c?.status).toBe("needs_reauth");
    expect(c?.needs_reauth_reason).toBe("messaging_webhook_subscribe_failed");
    expect(c?.last_error).toBe("messaging_webhook_subscribe_failed");
  });

  it("does NOT downgrade an FB-backed channel on failure, but surfaces a NON-SILENT warning + alert", async () => {
    if (!TEST_DB) return;
    const { MESSAGING_SUBSCRIBE_FAILED_FB_WARNING } = await import("./subscribe");
    // A full FB-login IG channel (real page token) — publishing/comments ride the Page token.
    await db.insert(s.channels).values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: IG_ID,
      display_name: "fb_ig",
      token_encrypted: encryptTokens({ access_token: "PAGE_TOK", page_id: "PG-1", messaging_token: "IGQW_TOK" }),
      webhook_secret: "s",
      status: "active",
    });

    const spy = vi.spyOn(InstagramProvider.prototype, "subscribeMessagingWebhooks").mockResolvedValue(false);
    const r = await subscribeInstagramMessaging(WS, IG_ID, "IGQW_TOK");

    expect(spy).toHaveBeenCalledWith("IGQW_TOK", IG_ID);
    expect(r.ok).toBe(false);
    const c = await getChannel();
    // FB page token present → publishing still works → stays active, not downgraded.
    expect(c?.status).toBe("active");
    // …but the IG-DM-receipt gap is NOT silent: a visible warning is stamped + the alert fired once.
    expect(c?.last_error).toBe(MESSAGING_SUBSCRIBE_FAILED_FB_WARNING);
    // It fires the dedicated `channel_degraded` warning type — NOT `channel_reauth` (the channel is
    // still active/impaired, not down), so a consumer routing on type doesn't read "channel down" and
    // a genuine reauth for the same channel keeps its own throttle bucket.
    const channelAlerts = alertBodies.filter((b) => b.channel_id === c?.id && b.type === "channel_degraded");
    expect(channelAlerts.length).toBe(1);
    expect(String(channelAlerts[0]!.detail)).toBe(MESSAGING_SUBSCRIBE_FAILED_FB_WARNING);
    // …and it is NOT mislabeled as a down/reauth event.
    expect(alertBodies.some((b) => b.channel_id === c?.id && b.type === "channel_reauth")).toBe(false);
  });

  // ITEM 2 (IGFU3 alreadyWarned guard): a repeated failed subscribe on an already-warned FB-backed
  // channel must NOT fire a second warning alert (the channel stays active, last_error stays the
  // warning). Mirrors the harness above.
  it("fires the FB-backed degraded warning EXACTLY ONCE across repeated failed subscribes", async () => {
    if (!TEST_DB) return;
    const { MESSAGING_SUBSCRIBE_FAILED_FB_WARNING } = await import("./subscribe");
    await db.insert(s.channels).values({
      workspace_id: WS,
      platform: "instagram",
      platform_id: IG_ID,
      display_name: "fb_ig",
      token_encrypted: encryptTokens({ access_token: "PAGE_TOK", page_id: "PG-1", messaging_token: "IGQW_TOK" }),
      webhook_secret: "s",
      status: "active",
    });

    const spy = vi.spyOn(InstagramProvider.prototype, "subscribeMessagingWebhooks").mockResolvedValue(false);
    await subscribeInstagramMessaging(WS, IG_ID, "IGQW_TOK");
    // Reset the per-(type,channel) alert throttle between calls so it CANNOT be the thing enforcing
    // "exactly once". With the throttle window cleared, a second alert is only suppressed by the
    // persisted `alreadyWarned` guard (channel.last_error === the warning) — so a still-once result
    // genuinely isolates that guard's contribution. (Same row-clear pattern as the PSA13/ITEM3 test.)
    const c1 = await getChannel();
    await db.execute(sql`delete from rate_limit_counters where key = ${"alert:channel_degraded:" + c1?.id}`);
    await subscribeInstagramMessaging(WS, IG_ID, "IGQW_TOK"); // already warned → must NOT re-alert

    expect(spy).toHaveBeenCalledTimes(2);
    const c = await getChannel();
    // Still active and still carrying the same warning — a second failure changed nothing visible.
    expect(c?.status).toBe("active");
    expect(c?.last_error).toBe(MESSAGING_SUBSCRIBE_FAILED_FB_WARNING);
    const channelAlerts = alertBodies.filter((b) => b.channel_id === c?.id && b.type === "channel_degraded");
    expect(channelAlerts.length).toBe(1);
  });
});
