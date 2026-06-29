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

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
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
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
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
    { augmentMessagingToken: { token: "IGQW_TOK", expiresAt: null } },
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

  it("subscribes but does NOT downgrade a channel that still receives via its FB page token", async () => {
    if (!TEST_DB) return;
    // A full FB-login IG channel (real page token) — its inbound rides the Page subscription.
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
    // FB page token present → still receives → stays active, not downgraded.
    expect((await getChannel())?.status).toBe("active");
  });
});
