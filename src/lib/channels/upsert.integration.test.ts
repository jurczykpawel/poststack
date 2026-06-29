import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";

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
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
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

  it("emits channel.created on first connect and channel.reconnected on a later connect", async () => {
    if (!TEST_DB) return;
    await upsertChannels(WS, "facebook", [account("First Name")]);
    const c = await getChannel();
    const created = await db.query.events.findMany({ where: and(eq(s.events.workspace_id, WS), eq(s.events.subject_id, c!.id)) });
    expect(created.map((e) => e.type)).toEqual(["channel.created"]);

    await upsertChannels(WS, "facebook", [account("First Name")]); // reconnect (same account)
    const all = await db.query.events.findMany({ where: and(eq(s.events.workspace_id, WS), eq(s.events.subject_id, c!.id)), orderBy: s.events.created_at });
    expect(all.map((e) => e.type)).toEqual(["channel.created", "channel.reconnected"]);
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

  it("deferDrain returns the recovered channels without enqueuing the drain (caller drains after confirming)", async () => {
    if (!TEST_DB) return;
    await upsertChannels(WS, "facebook", [account("X")]);
    await db.update(s.channels).set({ status: "needs_reauth" }).where(eq(s.channels.platform_id, PAGE));
    const before = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'drain-channel'`);
    const { recoveredChannelIds } = await upsertChannels(WS, "facebook", [account("X")], { deferDrain: true });
    const c = await getChannel();
    expect(recoveredChannelIds).toEqual([c!.id]);
    // No drain was enqueued — the caller will do it once the channel is confirmed working.
    const after = await db.execute(sql`select count(*)::int as n from graphile_worker.jobs where task_identifier = 'drain-channel'`);
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n);
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

  it("rejects a second ACTIVE channel for the same account across workspaces, but lets a disabled one coexist", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c3";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "X", slug: `x-${WS2}` });
    try {
      await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: "DUP", token_encrypted: "x", webhook_secret: "a" });
      // A second NON-disabled channel for the same account (even in another
      // workspace, bypassing the app-layer check) is refused by the partial unique
      // index — routing must resolve to exactly one live owner per account.
      await expect(
        db.insert(s.channels).values({ workspace_id: WS2, platform: "facebook", platform_id: "DUP", token_encrypted: "x", webhook_secret: "b" }),
      ).rejects.toThrow();
      // A DISABLED row is exempt, so a released account can be reconnected elsewhere
      // and the dedup migration (disable-then-index) is safe.
      await db.insert(s.channels).values({ workspace_id: WS2, platform: "facebook", platform_id: "DUP", token_encrypted: "x", webhook_secret: "c", status: "disabled" });
      const rows = await db.select().from(s.channels).where(eq(s.channels.platform_id, "DUP"));
      expect(rows.length).toBe(2);
      expect(rows.filter((r) => r.status !== "disabled").length).toBe(1);
    } finally {
      await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    }
  });

  it("serializes concurrent connects of the same account so only one workspace wins", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c4";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "P", slug: `p-${WS2}` });
    try {
      const PAGE_X = "RACE_PAGE";
      const a = upsertChannels(WS, "facebook", [{ platformId: PAGE_X, displayName: "A", tokens: { access_token: "a" } }]);
      const b = upsertChannels(WS2, "facebook", [{ platformId: PAGE_X, displayName: "B", tokens: { access_token: "b" } }]);
      const results = await Promise.allSettled([a, b]);
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
      expect(results.filter((r) => r.status === "rejected").length).toBe(1);
      const rows = await db.select().from(s.channels).where(eq(s.channels.platform_id, PAGE_X));
      expect(rows.length).toBe(1); // never two owners
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

  it("a stale (disabled) owner reconnecting an account that is live elsewhere gets a clean error, not a constraint crash", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c6";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "Live", slug: `live-${WS2}` });
    try {
      const ACCT = "STALE-PAGE";
      // The caller (WS) used to own this account, but its channel is now disabled.
      await db.insert(s.channels).values({ workspace_id: WS, platform: "facebook", platform_id: ACCT, token_encrypted: "x", webhook_secret: "old", status: "disabled" });
      // WS2 now owns it live.
      await upsertChannels(WS2, "facebook", [{ platformId: ACCT, displayName: "Live", tokens: { access_token: "t" } }]);
      // WS reconnects. The ownership check must look at the LIVE owner deterministically
      // and reject cleanly — not pass on its own disabled row and then hit a raw unique
      // constraint when the upsert tries to re-activate it.
      await expect(
        upsertChannels(WS, "facebook", [{ platformId: ACCT, displayName: "Reclaim", tokens: { access_token: "r" } }]),
      ).rejects.toThrow(/another workspace/);
      const wsChan = await db.query.channels.findFirst({ where: and(eq(s.channels.workspace_id, WS), eq(s.channels.platform_id, ACCT)) });
      expect(wsChan?.status).toBe("disabled"); // untouched
      const active = await db.select().from(s.channels).where(and(eq(s.channels.platform_id, ACCT), ne(s.channels.status, "disabled")));
      expect(active.length).toBe(1);
      expect(active[0].workspace_id).toBe(WS2);
    } finally {
      await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    }
  });

  it("augmentMessagingToken adds the IG-Login messaging_token to an existing channel WITHOUT clobbering the FB page token", async () => {
    if (!TEST_DB) return;
    const { decryptTokens } = await import("@/lib/crypto");
    const IG = "IG-AUGMENT-1";
    // Existing IG channel connected via Facebook Login (carries an FB page token + page_id).
    await upsertChannels(WS, "instagram", [
      { platformId: IG, displayName: "Acme IG", username: "acme", tokens: { access_token: "fb-page-tok", page_id: "PAGE-1", user_access_token: "fb-user-tok" } },
    ]);
    const before = await db.query.channels.findFirst({ where: and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)) });
    expect(before).toBeTruthy();

    const exp = new Date(Date.now() + 5184000 * 1000);
    await upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Acme IG", username: "acme", tokens: { access_token: "" } }], {
      augmentMessagingToken: { token: "IGQW_msg_tok", expiresAt: exp },
    });

    const after = await db.query.channels.findFirst({ where: and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)) });
    expect(after!.id).toBe(before!.id); // same row, augmented in place
    // End-to-end dedup guarantee: Facebook-login THEN Instagram-Login augment for the SAME
    // platform_id collapses to exactly ONE channel row (no duplicate IG-Login-only row).
    const cnt = await db.execute(
      sql`select count(*)::int as n from channels where workspace_id = ${WS} and platform = 'instagram' and platform_id = ${IG}`,
    );
    expect((cnt.rows[0] as { n: number }).n).toBe(1);
    const blob = decryptTokens(after!.token_encrypted);
    expect(blob.messaging_token).toBe("IGQW_msg_tok"); // messaging token added
    expect(blob.access_token).toBe("fb-page-tok"); // FB page token UNTOUCHED
    expect(blob.page_id).toBe("PAGE-1"); // page_id UNTOUCHED
    expect(blob.user_access_token).toBe("fb-user-tok"); // user token UNTOUCHED
    expect(typeof blob.messaging_token_expires_at).toBe("number"); // unix seconds in blob
    expect(after!.messaging_token_expires_at).not.toBeNull(); // plaintext death-clock column set
    expect(after!.status).toBe("active");
  });

  it("augmentMessagingToken creates a minimal IG-Login-only channel when no channel exists for that account", async () => {
    if (!TEST_DB) return;
    const { decryptTokens } = await import("@/lib/crypto");
    const IG = "IG-AUGMENT-NEW";
    const exp = new Date(Date.now() + 5184000 * 1000);
    await upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Solo IG", username: "solo", tokens: { access_token: "" } }], {
      augmentMessagingToken: { token: "IGQW_only", expiresAt: exp },
    });
    const c = await db.query.channels.findFirst({ where: and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)) });
    expect(c).toBeTruthy();
    expect(c!.webhook_secret?.length).toBeGreaterThan(0);
    expect(c!.status).toBe("active");
    expect(c!.messaging_token_expires_at).not.toBeNull();
    const blob = decryptTokens(c!.token_encrypted);
    expect(blob.messaging_token).toBe("IGQW_only");
  });

  it("A1: a later FB-SIDE main-path write must NOT clobber a previously augmented IG-Login messaging_token", async () => {
    if (!TEST_DB) return;
    const { decryptTokens } = await import("@/lib/crypto");
    const IG = "IG-CLOBBER-1";
    // 1) IG channel augmented with an IG-Login messaging_token (minimal IG-Login-only channel).
    const exp = new Date(Date.now() + 5184000 * 1000);
    await upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Acme IG", username: "acme", tokens: { access_token: "" } }], {
      augmentMessagingToken: { token: "IGQW_keepme", expiresAt: exp },
    });
    const augmented = await db.query.channels.findFirst({ where: and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)) });
    expect(augmented).toBeTruthy();
    expect(augmented!.messaging_token_expires_at).not.toBeNull();
    expect(decryptTokens(augmented!.token_encrypted).messaging_token).toBe("IGQW_keepme");

    // 2) A later FB-SIDE write to the SAME platform_id (FB-login reconnect / manual-token / managed-source cron).
    //    The FB-only blob must NOT drop the messaging_token, and the death-clock column must stay consistent.
    await upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Acme IG", username: "acme", tokens: { access_token: "FB2", page_id: "PG" } }]);

    const rows = await db.select().from(s.channels).where(and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)));
    expect(rows.length).toBe(1); // exactly one row, augmented-in-place
    const after = rows[0];
    const blob = decryptTokens(after.token_encrypted);
    expect(blob.messaging_token).toBe("IGQW_keepme"); // PRESERVED across the FB-side write
    expect(blob.access_token).toBe("FB2"); // new FB page token applied
    expect(blob.page_id).toBe("PG"); // new FB page_id applied
    expect(typeof blob.messaging_token_expires_at).toBe("number"); // in-blob expiry preserved
    expect(after.messaging_token_expires_at).not.toBeNull(); // death-clock column still set (consistent with blob)
  });

  it("A6: augment minimal-create revives a DISABLED row instead of crashing on the full unique index", async () => {
    if (!TEST_DB) return;
    const { decryptTokens } = await import("@/lib/crypto");
    const IG = "IG-REVIVE-1";
    // A disabled row already exists for this exact (workspace, platform, platform_id).
    await upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Old IG", username: "old", tokens: { access_token: "old" } }]);
    await db.update(s.channels).set({ status: "disabled" }).where(and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)));

    // IG-Login-connecting this previously-disabled account must NOT 500 on a unique-constraint violation.
    const exp = new Date(Date.now() + 5184000 * 1000);
    await expect(
      upsertChannels(WS, "instagram", [{ platformId: IG, displayName: "Revived IG", username: "rev", tokens: { access_token: "" } }], {
        augmentMessagingToken: { token: "IGQW_revive", expiresAt: exp },
      }),
    ).resolves.toBeTruthy();

    const rows = await db.select().from(s.channels).where(and(eq(s.channels.platform, "instagram"), eq(s.channels.platform_id, IG)));
    expect(rows.length).toBe(1); // revived in place, not a duplicate
    const c = rows[0];
    expect(c.status).toBe("active");
    expect(c.last_error).toBeNull();
    expect(c.messaging_token_expires_at).not.toBeNull();
    expect(decryptTokens(c.token_encrypted).messaging_token).toBe("IGQW_revive");
  });

  it("connecting several accounts is atomic — a later account's rejection rolls back the earlier ones", async () => {
    if (!TEST_DB) return;
    const WS2 = "eeeeeeee-0000-0000-0000-0000000000c5";
    await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    await db.insert(s.workspaces).values({ id: WS2, name: "Owner", slug: `ow-${WS2}` });
    try {
      // WS2 already owns "OWNED".
      await upsertChannels(WS2, "facebook", [{ platformId: "OWNED", displayName: "Owned", tokens: { access_token: "x" } }]);
      // WS connects a free account AND the owned one in a single call. The owned
      // account belongs to WS2, so the whole operation must fail without leaving
      // the free account half-connected.
      await expect(
        upsertChannels(WS, "facebook", [
          { platformId: "FREE-ACCT", displayName: "Free", tokens: { access_token: "f" } },
          { platformId: "OWNED", displayName: "Hijack", tokens: { access_token: "h" } },
        ]),
      ).rejects.toThrow(/another workspace/);

      const free = await db.select().from(s.channels).where(and(eq(s.channels.workspace_id, WS), eq(s.channels.platform_id, "FREE-ACCT")));
      expect(free.length).toBe(0); // rolled back, not persisted
    } finally {
      await db.delete(s.workspaces).where(eq(s.workspaces.id, WS2));
    }
  });
});
