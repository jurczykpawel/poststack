import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let upsertChannels: typeof import("./upsert").upsertChannels;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

const WS = "eeeeeeee-0000-0000-0000-0000000000c1";
const PAGE = "PG-UPSERT";

const account = (displayName: string) => ({
  platformId: PAGE,
  displayName,
  username: "acct",
  tokens: { access_token: "tok" },
});

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ upsertChannels } = await import("./upsert"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.insert(s.workspaces).values({ id: WS, name: "U", slug: `u-${WS}` });
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table graphile_worker._private_jobs cascade`);
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  if (closeQueue) await closeQueue();
});

function getChannel() {
  return db.query.channels.findFirst({
    where: and(eq(s.channels.workspace_id, WS), eq(s.channels.platform_id, PAGE)),
  });
}

describe("upsertChannels (real Postgres)", () => {
  it("creates a new channel with a webhook secret and active status", async () => {
    if (!TEST_DB) return;
    await upsertChannels(WS, "facebook", [account("First Name")]);
    const c = await getChannel();
    expect(c?.display_name).toBe("First Name");
    expect(c?.status).toBe("active");
    expect(c?.webhook_secret?.length).toBeGreaterThan(0);
    expect(c?.connection_mode).toBe("oauth");
  });

  it("updates an existing channel without rotating the webhook secret", async () => {
    if (!TEST_DB) return;
    await upsertChannels(WS, "facebook", [account("First Name")]);
    const before = await getChannel();
    await upsertChannels(WS, "facebook", [account("Renamed")]);
    const after = await getChannel();
    expect(after?.display_name).toBe("Renamed");
    expect(after?.webhook_secret).toBe(before?.webhook_secret);
    expect(after?.id).toBe(before?.id);
  });

  it("recovers a needs_reauth channel and enqueues a drain on reconnect", async () => {
    if (!TEST_DB) return;
    await upsertChannels(WS, "facebook", [account("X")]);
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.platform_id, PAGE));
    await upsertChannels(WS, "facebook", [account("X")]);
    const c = await getChannel();
    expect(c?.status).toBe("active");
    const jobs = await db.execute(sql`select task_identifier from graphile_worker.jobs where task_identifier = 'drain-channel'`);
    expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects more than the per-call account cap", async () => {
    if (!TEST_DB) return;
    const many = Array.from({ length: 51 }, (_, i) => account(`n${i}`));
    await expect(upsertChannels(WS, "facebook", many)).rejects.toThrow(/Too many accounts/);
  });

  it("a Telegram bot and a Facebook page with the same numeric id do not collide", async () => {
    if (!TEST_DB) return;
    const COLLIDE = "100200300";
    await upsertChannels(WS, "facebook", [{ platformId: COLLIDE, displayName: "FB Page", tokens: { access_token: "fb-token" } }]);
    const fbBefore = await db.query.channels.findFirst({
      where: and(eq(s.channels.platform, "facebook"), eq(s.channels.platform_id, COLLIDE)),
      columns: { id: true, token_encrypted: true },
    });
    expect(fbBefore).toBeTruthy();

    // Connecting a Telegram bot with the same numeric id must NOT overwrite the FB channel.
    await upsertChannels(WS, "telegram", [{ platformId: COLLIDE, displayName: "TG Bot", tokens: { access_token: "tg-token" } }], { connectionMode: "manual_token" });

    const rows = await db.select().from(s.channels).where(eq(s.channels.platform_id, COLLIDE));
    expect(rows.length).toBe(2);
    const fbAfter = rows.find((r) => r.platform === "facebook")!;
    const tg = rows.find((r) => r.platform === "telegram")!;
    expect(fbAfter.token_encrypted).toBe(fbBefore!.token_encrypted); // untouched
    expect(fbAfter.id).toBe(fbBefore!.id);
    expect(tg.id).not.toBe(fbBefore!.id);
  });

  it("the DB permits the same (platform, platform_id) across workspaces (unique index is a superset of the old key)", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c3";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "X", slug: `x-${WS2}` });
    try {
      // Direct inserts (bypassing the app-layer ownership check) must be allowed by
      // the constraint — this is exactly the data the old schema permitted, so the
      // unique-index migration can never fail on it.
      await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: "DUP", token_encrypted: "x", webhook_secret: "a" });
      await db.insert(s.channels).values({ workspace_id: WS2, platform: "facebook", platform_id: "DUP", token_encrypted: "x", webhook_secret: "b" });
      const rows = await db.select().from(s.channels).where(eq(s.channels.platform_id, "DUP"));
      expect(rows.length).toBe(2);
    } finally {
      await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    }
  });

  it("refuses to connect a channel already owned by another workspace", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c2";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "Other", slug: `o-${WS2}` });
    try {
      await upsertChannels(WS, "facebook", [account("Owner A")]);
      const before = await getChannel();

      await expect(
        upsertChannels(WS2, "facebook", [{ platformId: PAGE, displayName: "Hijack", tokens: { access_token: "evil" } }]),
      ).rejects.toThrow(/another workspace/);

      const after = await getChannel();
      expect(after?.id).toBe(before?.id);
      expect(after?.token_encrypted).toBe(before?.token_encrypted); // not clobbered
      expect(after?.display_name).toBe("Owner A");
      const inWs2 = await db.select().from(s.channels).where(and(eq(s.channels.workspace_id, WS2), eq(s.channels.platform_id, PAGE)));
      expect(inWs2.length).toBe(0);
    } finally {
      await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    }
  });
});
