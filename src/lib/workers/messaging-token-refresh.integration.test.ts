import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { TokenInvalidError } from "@/lib/platforms/errors";

// Queue boundary stubbed (the messaging refresh path never enqueues, but markChannelHealthy/drain
// elsewhere might — keep it inert). DB + crypto are real.
vi.mock("@/lib/queue/client", () => ({
  addJob: vi.fn(async () => {}),
  addJobTx: vi.fn(async () => {}),
  closeQueue: vi.fn(async () => {}),
}));

// Stub the provider so refreshMessagingToken is deterministic (no live IG call). instagram platform
// → a provider exposing refreshMessagingToken; the success/failure behaviour is set per-test.
const refreshMessagingToken = vi.fn();
const refreshToken = vi.fn(async () => ({ access_token: "should-not-be-called" }));
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({
    requiresTokenRefresh: () => true,
    refreshBufferSeconds: () => 10 * 24 * 60 * 60,
    refreshToken,
    refreshMessagingToken,
  }),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let crypto: typeof import("@/lib/crypto");
let processTokenRefresh: typeof import("./token-refresh-worker").processTokenRefresh;

const WS = "eeeeeeee-1111-0000-0000-0000000000c1";
const CH = "eeeeeeee-1111-0000-0000-0000000000c2";

const helpers = { logger: { info: () => {}, error: () => {} } } as unknown as Parameters<
  typeof import("./token-refresh-worker").processTokenRefresh
>[1];

// Capture dispatched alerts by stubbing fetch (dispatchAlert POSTs to CHANNEL_ALERT_WEBHOOK_URL).
let realFetch: typeof fetch;
let alerts: Array<{ type: string; channel_id?: string; detail?: string }>;

const NEAR_EXPIRY_UNIX = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60; // 5d out — inside 10d buffer

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  crypto = await import("@/lib/crypto");
  ({ processTokenRefresh } = await import("./token-refresh-worker"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  refreshMessagingToken.mockReset();
  process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
  await db.execute(sql`delete from rate_limit_counters where key like 'alert:%'`);
  alerts = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    alerts.push(JSON.parse(init!.body as string));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "MT", slug: `mt-${WS}` });
  await db.insert(s.channels).values({
    id: CH,
    workspace_id: WS,
    platform: "instagram",
    platform_id: "IG-MT",
    // FB page token + IG-Login messaging token coexist in the blob; the messaging token is what we refresh.
    token_encrypted: crypto.encryptTokens({
      access_token: "fb-page-tok",
      messaging_token: "IGQW_old",
      messaging_token_expires_at: NEAR_EXPIRY_UNIX,
    }),
    webhook_secret: "s",
    status: "active",
    connection_mode: "oauth",
    messaging_token_expires_at: new Date(NEAR_EXPIRY_UNIX * 1000),
  });
});

afterEach(() => {
  if (!TEST_DB) return;
  globalThis.fetch = realFetch;
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

const storedBlob = async () => {
  const c = await db.query.channels.findFirst({
    where: eq(s.channels.id, CH),
    columns: { token_encrypted: true, messaging_token_expires_at: true, status: true, last_error: true },
  });
  return { blob: crypto.decryptTokens(c!.token_encrypted), ...c! };
};

describe("IG-Login messaging token refresh (IGML6 life-support)", () => {
  it("refreshes a near-expiry messaging token: blob secret + both expiry clocks advance, FB token preserved", async () => {
    if (!TEST_DB) return;
    const newExpiry = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60; // +60d
    refreshMessagingToken.mockResolvedValueOnce({ token: "IGQW_new", expiresAt: newExpiry });

    await processTokenRefresh({ channelId: CH, kind: "messaging" }, helpers);

    expect(refreshMessagingToken).toHaveBeenCalledWith("IGQW_old");
    const { blob, messaging_token_expires_at, status } = await storedBlob();
    expect(blob.messaging_token).toBe("IGQW_new"); // re-encrypted secret advanced
    expect(blob.messaging_token_expires_at).toBe(newExpiry); // in-blob unix expiry advanced
    expect(blob.access_token).toBe("fb-page-tok"); // FB page token preserved
    expect(messaging_token_expires_at!.getTime()).toBe(newExpiry * 1000); // plaintext column advanced
    expect(status).toBe("active"); // a live channel stays active
    expect(alerts.length).toBe(0); // a healthy refresh raises no alert
  });

  it("a dead messaging token (refresh rejected) → needs_reauth(messaging_token_expired) + channel-down alert", async () => {
    if (!TEST_DB) return;
    refreshMessagingToken.mockRejectedValueOnce(new TokenInvalidError("messaging token expired"));

    await processTokenRefresh({ channelId: CH, kind: "messaging" }, helpers);

    const { status, last_error, blob } = await storedBlob();
    expect(status).toBe("needs_reauth");
    expect(last_error).toBe("messaging_token_expired");
    expect(blob.messaging_token).toBe("IGQW_old"); // untouched — nothing to write on failure
    // REL3: the channel-down alert fires on the ok→down transition.
    expect(alerts.some((a) => a.type === "channel_reauth" && a.channel_id === CH)).toBe(true);
  });

  it("an undecryptable token blob → needs_reauth, provider never called", async () => {
    if (!TEST_DB) return;
    const corrupt = crypto.encryptTokens({ access_token: "x", messaging_token: "y" }).split(":");
    corrupt[2] = "deadbeef";
    await db.update(s.channels).set({ token_encrypted: corrupt.join(":") }).where(eq(s.channels.id, CH));

    await processTokenRefresh({ channelId: CH, kind: "messaging" }, helpers);

    expect(refreshMessagingToken).not.toHaveBeenCalled();
    const c = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { status: true } });
    expect(c?.status).toBe("needs_reauth");
  });
});

describe("concurrent FB + messaging refresh on the same channel row (no blob clobber)", () => {
  it("interleaved FB and messaging refreshes both land: neither token reverts (lost-update guard)", async () => {
    if (!TEST_DB) return;
    const newExpiry = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60; // +60d

    // Force a true interleave: BOTH jobs decrypt their pre-HTTP snapshot of the SAME blob, then wait
    // on a shared barrier so neither persists until both snapshots are captured stale. Without the
    // row-locked re-read-merge-write, whichever transaction commits last reverts the other's field.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const barrier = async () => {
      if (++arrived === 2) release();
      await gate;
    };

    // FB refresh spreads the pre-HTTP snapshot (carrying the STALE messaging_token) and advances only
    // the FB token/expiry — exactly like instagram.refreshToken (`{ ...tokens, user_access_token, ... }`).
    (refreshToken as ReturnType<typeof vi.fn>).mockImplementation(async (tokens: Record<string, unknown>) => {
      await barrier();
      return { ...tokens, access_token: "fb-new", user_access_token: "user-new", expires_at: newExpiry };
    });
    (refreshMessagingToken as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await barrier();
      return { token: "IGQW_new", expiresAt: newExpiry };
    });

    await Promise.all([
      processTokenRefresh({ channelId: CH, kind: "oauth" }, helpers),
      processTokenRefresh({ channelId: CH, kind: "messaging" }, helpers),
    ]);

    const { blob, messaging_token_expires_at } = await storedBlob();
    // BOTH writers' fields survive — neither clobbered the other.
    expect(blob.access_token).toBe("fb-new"); // FB write landed
    expect(blob.user_access_token).toBe("user-new"); // FB write landed
    expect(blob.messaging_token).toBe("IGQW_new"); // messaging write NOT reverted by the FB write
    expect(blob.messaging_token_expires_at).toBe(newExpiry); // in-blob messaging expiry advanced
    expect(messaging_token_expires_at!.getTime()).toBe(newExpiry * 1000); // plaintext column matches the messaging write
  });
});

describe("scan enqueues messaging-token refresh on its own clock (IGML6)", () => {
  it("enqueues a kind:messaging job with a distinct jobKey for a near-expiry messaging token", async () => {
    if (!TEST_DB) return;
    const { addJob } = await import("@/lib/queue/client");
    (addJob as ReturnType<typeof vi.fn>).mockClear();
    const { scanExpiringTokens } = await import("./token-refresh-scan");

    await scanExpiringTokens();

    expect(addJob).toHaveBeenCalledWith(
      "token-refresh",
      { channelId: CH, kind: "messaging" },
      { jobKey: `messaging-token-refresh-${CH}` },
    );
  });
});
