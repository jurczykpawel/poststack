import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";

// Mock the Telegram provider (network) and the queue client so we can drive a
// drain-enqueue failure. The DB, upsert, auth and audit paths are all real.
const provider = {
  connectWithToken: vi.fn(),
  setWebhook: vi.fn(async () => {}),
};
vi.mock("@/lib/platforms/registry", () => ({ getProvider: () => provider }));
const addJob = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("@/lib/queue/client", () => ({
  addJob: (...a: unknown[]) => addJob(...a),
  closeQueue: async () => {},
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
const RAW_KEY = "sk_live_tg_drain_test_key_0123456789";
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAA";

let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let POST: typeof import("./route").POST;

const WS = "cccccccc-0000-0000-0000-0000000000d1";
const CH = "cccccccc-0000-0000-0000-0000000000d2";
const BOT = "BOT-DRAIN-1";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ POST } = await import("./route"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  vi.clearAllMocks();
  provider.connectWithToken.mockResolvedValue([
    { platformId: BOT, displayName: "Bot", username: "bot", tokens: { access_token: "t" } },
  ]);
  provider.setWebhook.mockResolvedValue(undefined);
  // Start from a broken channel (needs_reauth) so connect is a recovery + drain.
  await db.delete(s.channels).where(eq(s.channels.platform_id, BOT));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "TG", slug: `tg-${WS}` });
  await db.insert(s.apiKeys).values({
    workspace_id: WS, name: "k",
    key_hash: createHash("sha256").update(RAW_KEY).digest("hex"),
    key_prefix: "sk_live_tg_dr",
  });
  await db.insert(s.channels).values({
    id: CH, workspace_id: WS, platform: "telegram", platform_id: BOT,
    token_encrypted: "x", webhook_secret: "wh-secret", status: "needs_reauth",
    connection_mode: "manual_token",
  });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.channels).where(eq(s.channels.platform_id, BOT));
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
});

function connectReq() {
  return new Request("http://x/api/v1/channels/telegram/connect", {
    method: "POST",
    headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
}

function channelRow() {
  return db.query.channels.findFirst({
    where: and(eq(s.channels.workspace_id, WS), eq(s.channels.platform_id, BOT)),
    columns: { status: true },
  });
}

describe("telegram connect — held-message drain is retryable", () => {
  it("rolls a recovered channel back to needs_reauth when the drain can't be queued, and the next connect drains it", async () => {
    if (!TEST_DB) return;

    // First connect: setWebhook succeeds but scheduling the drain fails. The channel
    // must not be left active-without-drain (held messages would strand).
    addJob.mockRejectedValueOnce(new Error("queue down"));
    const res1 = await POST(connectReq());
    expect(res1.status).toBe(400);
    expect((await channelRow())?.status).toBe("needs_reauth");

    // Second connect: the channel is needs_reauth again, so it re-recovers and the
    // drain is enqueued this time.
    const res2 = await POST(connectReq());
    expect(res2.status).toBe(201);
    expect((await channelRow())?.status).toBe("active");

    // Exactly one drain was enqueued across both attempts (the failed one + the retry).
    const drainCalls = addJob.mock.calls.filter((c) => c[0] === "drain-channel");
    expect(drainCalls.length).toBe(2); // attempted twice
    expect(drainCalls[1][1]).toEqual({ channelId: CH });
    // a deterministic jobKey coalesces concurrent reconnect drains.
    expect(drainCalls[1][2]).toEqual({ jobKey: `drain-channel:${CH}` });
  });
});
