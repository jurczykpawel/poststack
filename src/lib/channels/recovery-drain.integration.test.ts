import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";

// Mock the queue boundary so we can inject a drain-enqueue failure; the DB is real.
const addJobTx = vi.fn(async () => {});
vi.mock("@/lib/queue/client", () => ({
  addJobTx,
  addJob: vi.fn(async () => {}),
  closeQueue: vi.fn(async () => {}),
}));

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let health: typeof import("./health");
let upsert: typeof import("./upsert");

const WS = "dddddddd-0000-0000-0000-0000000000a1";
const CH = "dddddddd-0000-0000-0000-0000000000a2";
const PAGE = "PG-RD-39";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  health = await import("./health");
  upsert = await import("./upsert");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  addJobTx.mockReset();
  addJobTx.mockResolvedValue(undefined);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "RD", slug: `rd-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.$client.end?.();
});

const statusOf = async () =>
  (await db.query.channels.findFirst({ where: eq(s.channels.id, CH), columns: { status: true } }))?.status;

const account = (name: string) => ({ platformId: PAGE, displayName: name, tokens: { access_token: "t" } });

describe("recovery → drain is atomic", () => {
  it("markChannelHealthy: a failed drain enqueue rolls back the recovery, the retry re-drains", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      id: CH, workspace_id: WS, platform: "instagram", platform_id: PAGE,
      token_encrypted: "e", webhook_secret: "s", status: "needs_reauth",
    });

    addJobTx.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(health.markChannelHealthy(CH)).rejects.toThrow();
    // The status flip is rolled back with the failed enqueue — not stranded active-without-drain.
    expect(await statusOf()).toBe("needs_reauth");

    // The next retry recognises the still-broken channel and recovers + drains.
    await health.markChannelHealthy(CH);
    expect(await statusOf()).toBe("active");
    expect(addJobTx).toHaveBeenLastCalledWith(
      expect.anything(), "drain-channel", { channelId: CH }, expect.objectContaining({ jobKey: `drain-channel:${CH}` }),
    );
  });

  it("upsertChannels: a failed drain enqueue rolls back the reconnect, the retry re-drains", async () => {
    if (!TEST_DB) return;
    await upsert.upsertChannels(WS, "instagram", [account("Original")]);
    await db.update(s.channels).set({ status: "needs_reauth", display_name: "Original" }).where(eq(s.channels.platform_id, PAGE));

    addJobTx.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(upsert.upsertChannels(WS, "instagram", [account("Renamed")])).rejects.toThrow();

    // The whole reconnect (status flip AND the rename) rolled back — the channel stays in a
    // state the next retry recognises as needing recovery.
    const c = await db.query.channels.findFirst({ where: eq(s.channels.platform_id, PAGE), columns: { status: true, display_name: true } });
    expect(c?.status).toBe("needs_reauth");
    expect(c?.display_name).toBe("Original");

    // Retry recovers + drains.
    await upsert.upsertChannels(WS, "instagram", [account("Renamed")]);
    const after = await db.query.channels.findFirst({ where: eq(s.channels.platform_id, PAGE), columns: { status: true } });
    expect(after?.status).toBe("active");
    expect(addJobTx).toHaveBeenLastCalledWith(
      expect.anything(), "drain-channel", expect.objectContaining({ channelId: expect.any(String) }), expect.objectContaining({ jobKey: expect.stringContaining("drain-channel:") }),
    );
  });
});
