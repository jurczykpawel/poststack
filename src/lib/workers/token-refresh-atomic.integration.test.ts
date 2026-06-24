import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the queue boundary so we can inject a drain-enqueue failure; the DB + crypto are real.
const addJobTx = vi.fn(async () => {});
vi.mock("@/lib/queue/client", () => ({
  addJobTx,
  addJob: vi.fn(async () => {}),
  closeQueue: vi.fn(async () => {}),
}));

// Stub the provider so refreshToken is deterministic (no live Meta call) and always "succeeds".
const refreshToken = vi.fn(async () => ({ access_token: "new", expires_at: Math.floor(Date.now() / 1000) + 5_000_000 }));
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({
    requiresTokenRefresh: () => true,
    refreshToken,
    refreshBufferSeconds: () => 0,
  }),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let crypto: typeof import("@/lib/crypto");
let processTokenRefresh: typeof import("./token-refresh-worker").processTokenRefresh;

const WS = "eeeeeeee-0000-0000-0000-0000000000b1";
const CH = "eeeeeeee-0000-0000-0000-0000000000b2";

const helpers = { logger: { info: () => {}, error: () => {} } } as unknown as Parameters<typeof import("./token-refresh-worker").processTokenRefresh>[1];

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
  addJobTx.mockReset();
  addJobTx.mockResolvedValue(undefined);
  refreshToken.mockClear();
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "TR", slug: `tr-${WS}` });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-TR",
    token_encrypted: crypto.encryptTokens({ access_token: "old", expires_at: Math.floor(Date.now() / 1000) + 10 }),
    webhook_secret: "s", status: "needs_reauth", connection_mode: "oauth",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

const storedToken = async () => {
  const c = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { token_encrypted: true, status: true } });
  return { access_token: crypto.decryptTokens(c!.token_encrypted).access_token, status: c!.status };
};

// the refreshed-token write and the markChannelHealthy status flip + drain enqueue must
// commit together. Otherwise a crash/failure between them leaves the new token persisted but the
// channel stuck needs_reauth with no drain — held messages strand behind a "recovered" token.
describe("token refresh is atomic with the health flip", () => {
  it("rolls the new token back when the recovery drain enqueue fails", async () => {
    if (!TEST_DB) return;
    addJobTx.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(processTokenRefresh({ channelId: CH }, helpers)).rejects.toThrow();

    // Neither the token write NOR the status flip landed — both rolled back together.
    expect(await storedToken()).toEqual({ access_token: "old", status: "needs_reauth" });
  });

  it("persists the new token and flips to active + drains on success", async () => {
    if (!TEST_DB) return;
    await processTokenRefresh({ channelId: CH }, helpers);
    expect(await storedToken()).toEqual({ access_token: "new", status: "active" });
    // The surfaced token_expires_at must track the refreshed token (refreshToken returned now+5_000_000s),
    // not stay frozen at the connect-time value (now+10s) — otherwise the UI/scan see a stale expiry.
    const c = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { token_expires_at: true } });
    expect(c!.token_expires_at).toBeTruthy();
    expect(c!.token_expires_at!.getTime()).toBeGreaterThan(Date.now() + 1_000_000_000);
    expect(addJobTx).toHaveBeenLastCalledWith(
      expect.anything(), "drain-channel", { channelId: CH }, expect.objectContaining({ jobKey: `drain-channel:${CH}` }),
    );
  });
});

// a stored token that can't be decrypted (corruption / a rotated ENCRYPTION_KEY
// without re-encrypt) must flag the channel needs_reauth and stop, exactly like a token the
// provider rejects — not throw out of the worker and dead-letter the refresh job with no signal.
describe("token refresh on an undecryptable token", () => {
  it("flags needs_reauth and does not refresh when the stored token cannot be decrypted", async () => {
    if (!TEST_DB) return;
    // Overwrite with ciphertext that won't authenticate under the active key (corrupt body).
    const corrupt = crypto.encryptTokens({ access_token: "old" }).split(":");
    corrupt[2] = "deadbeef";
    await db.update(s.channels).set({ token_encrypted: corrupt.join(":"), status: "active" }).where(eq(s.channels.id, CH));

    await processTokenRefresh({ channelId: CH }, helpers);

    expect(refreshToken).not.toHaveBeenCalled(); // never reached the provider
    const c = await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { status: true } });
    expect(c?.status).toBe("needs_reauth");
  });
});
