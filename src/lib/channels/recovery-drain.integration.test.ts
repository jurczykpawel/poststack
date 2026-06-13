import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash } from "crypto";
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
let channelRoute: typeof import("@/server/handlers/v1/channels/[channelId]/route");

const WS = "dddddddd-0000-0000-0000-0000000000a1";
const CH = "dddddddd-0000-0000-0000-0000000000a2";
const PAGE = "PG-RD-39";
const RAW_KEY = "sk_live_recovery_drain_key_abcdef01";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  health = await import("./health");
  upsert = await import("./upsert");
  channelRoute = await import("@/server/handlers/v1/channels/[channelId]/route");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  addJobTx.mockReset();
  addJobTx.mockResolvedValue(undefined);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "RD", slug: `rd-${WS}` });
  await db.insert(s.apiKeys).values({
    workspace_id: WS, name: "k", key_hash: createHash("sha256").update(RAW_KEY).digest("hex"), key_prefix: "sk_live_re",
  });
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

// the operator PATCH resume path had the same non-atomic resume→drain as the
// other paths. The status flip and the drain enqueue must commit together.
describe("operator PATCH channel-resume → drain is atomic", () => {
  const patchReq = (body: unknown) =>
    new Request("http://x/api/v1/channels/x", {
      method: "PATCH",
      headers: { authorization: `Bearer ${RAW_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ctx = () => ({ params: Promise.resolve({ channelId: CH }) });

  it("a failed drain enqueue rolls back the resume; the retry resumes and drains", async () => {
    if (!TEST_DB) return;
    await db.insert(s.channels).values({
      id: CH, workspace_id: WS, platform: "instagram", platform_id: PAGE,
      token_encrypted: "e", webhook_secret: "s", status: "needs_reauth",
    });

    addJobTx.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(channelRoute.PATCH(patchReq({ status: "active" }), ctx())).rejects.toThrow();
    // The status flip rolled back with the failed enqueue — not stranded active-without-drain.
    expect(await statusOf()).toBe("needs_reauth");

    const res = await channelRoute.PATCH(patchReq({ status: "active" }), ctx());
    expect(res.status).toBe(200);
    expect(await statusOf()).toBe("active");
    expect(addJobTx).toHaveBeenLastCalledWith(
      expect.anything(), "drain-channel", { channelId: CH }, expect.objectContaining({ jobKey: `drain-channel:${CH}` }),
    );
  });
});
