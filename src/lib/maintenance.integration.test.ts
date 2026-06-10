import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let pruneExpired: typeof import("./maintenance").pruneExpired;

const WS = "aaaaaaaa-0000-0000-0000-0000000000f0";
const RULE = "aaaaaaaa-0000-0000-0000-0000000000f1";
const CONTACT_OLD = "aaaaaaaa-0000-0000-0000-0000000000f2";
const CONTACT_NEW = "aaaaaaaa-0000-0000-0000-0000000000f3";
const CH = "aaaaaaaa-0000-0000-0000-0000000000f4";
const CONV = "aaaaaaaa-0000-0000-0000-0000000000f5";
const APV_OLD = "aaaaaaaa-0000-0000-0000-0000000000f6";
const APV_PENDING = "aaaaaaaa-0000-0000-0000-0000000000f7";
const APV_RECENT = "aaaaaaaa-0000-0000-0000-0000000000f8";
const JTI_OLD = "maint-int-jti-old";
const JTI_NEW = "maint-int-jti-new";
const RL_OLD = "maint-int-rl-old";
const RL_NEW = "maint-int-rl-new";
const PE_OLD = "reaction:maint-int-pe-old";
const PE_NEW = "reaction:maint-int-pe-new";

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 3_600_000);
const DAY = 86_400_000;

async function cleanup() {
  // rule_cooldowns FK to rules + contacts; deleting the workspace cascades all three.
  await db.delete(s.workspaces).where(eq(s.workspaces.id, WS));
  await db.delete(s.revokedTokens).where(inArray(s.revokedTokens.jti, [JTI_OLD, JTI_NEW]));
  await db.delete(s.rateLimitCounters).where(inArray(s.rateLimitCounters.key, [RL_OLD, RL_NEW]));
  await db.delete(s.processedEvents).where(inArray(s.processedEvents.key, [PE_OLD, PE_NEW]));
}

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  s = await import("@/db/schema");
  ({ pruneExpired } = await import("./maintenance"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await cleanup();
  await db.insert(s.workspaces).values({ id: WS, name: "M", slug: `m-${WS}` });
  await db.insert(s.autoReplyRules).values({
    id: RULE, workspace_id: WS, name: "R", trigger_type: "keyword", trigger_config: {}, response_type: "text", response_config: { text: "x" },
  });
  await db.insert(s.contacts).values([{ id: CONTACT_OLD, workspace_id: WS }, { id: CONTACT_NEW, workspace_id: WS }]);
  await db.insert(s.ruleCooldowns).values([
    { rule_id: RULE, contact_id: CONTACT_OLD, expires_at: PAST },
    { rule_id: RULE, contact_id: CONTACT_NEW, expires_at: FUTURE },
  ]);
  await db.insert(s.revokedTokens).values([
    { jti: JTI_OLD, expires_at: PAST },
    { jti: JTI_NEW, expires_at: FUTURE },
  ]);
  await db.insert(s.rateLimitCounters).values([
    { key: RL_OLD, count: 1, window_start: new Date(NOW.getTime() - 7_200_000) },
    { key: RL_NEW, count: 1, window_start: NOW },
  ]);
  await db.insert(s.processedEvents).values([
    { key: PE_OLD, created_at: new Date(NOW.getTime() - 61 * DAY) },
    { key: PE_NEW, created_at: new Date(NOW.getTime() - 1 * DAY) },
  ]);

  //  fixtures: terminal delivery rows + resolved approvals (history that should age out),
  // alongside a held delivery + a pending approval (live state that must never be pruned).
  await db.insert(s.channels).values({ id: CH, workspace_id: WS, platform: "facebook", platform_id: "PG-MNT", token_encrypted: "x", webhook_secret: "s" });
  await db.insert(s.conversations).values({ id: CONV, workspace_id: WS, channel_id: CH, contact_id: CONTACT_NEW, platform: "facebook" });
  const OLD_TS = new Date(NOW.getTime() - 91 * DAY);
  const RECENT_TS = new Date(NOW.getTime() - 1 * DAY);
  await db.insert(s.outboundDeliveries).values([
    { delivery_key: "dk-term-old", workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "sent", payload: {}, updated_at: OLD_TS },
    { delivery_key: "dk-held-old", workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "held", payload: {}, updated_at: OLD_TS },
    { delivery_key: "dk-term-recent", workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "failed", payload: {}, updated_at: RECENT_TS },
  ]);
  await db.insert(s.pendingApprovals).values([
    { id: APV_OLD, workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT_NEW, channel_id: CH, recipient_platform_id: "PSID", proposed_content: {}, status: "approved", resolved_at: OLD_TS },
    { id: APV_PENDING, workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT_NEW, channel_id: CH, recipient_platform_id: "PSID", proposed_content: {}, status: "pending", created_at: OLD_TS },
    { id: APV_RECENT, workspace_id: WS, rule_id: RULE, conversation_id: CONV, contact_id: CONTACT_NEW, channel_id: CH, recipient_platform_id: "PSID", proposed_content: {}, status: "rejected", resolved_at: RECENT_TS },
  ]);
});

afterAll(async () => {
  if (TEST_DB) await cleanup();
});

describe("pruneExpired (real Postgres)", () => {
  it("removes expired ephemeral rows and keeps live ones", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);

    const cds = await db.select().from(s.ruleCooldowns).where(eq(s.ruleCooldowns.rule_id, RULE));
    expect(cds.map((r) => r.contact_id)).toEqual([CONTACT_NEW]);

    const toks = await db.select().from(s.revokedTokens).where(inArray(s.revokedTokens.jti, [JTI_OLD, JTI_NEW]));
    expect(toks.map((r) => r.jti)).toEqual([JTI_NEW]);
  });

  it("drops rate-limit windows older than an hour, keeps recent", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);
    const rls = await db.select().from(s.rateLimitCounters).where(inArray(s.rateLimitCounters.key, [RL_OLD, RL_NEW]));
    expect(rls.map((r) => r.key)).toEqual([RL_NEW]);
  });

  //  — event-dedup keys are pruned past the platform redelivery window so the table stays
  // bounded (and PSID-bearing reaction keys don't linger forever); recent keys stay so dedup
  // still works inside the window.
  it("prunes processed_events past the retention window, keeps recent", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);
    const evs = await db.select().from(s.processedEvents).where(inArray(s.processedEvents.key, [PE_OLD, PE_NEW]));
    expect(evs.map((r) => r.key)).toEqual([PE_NEW]);
  });

  //  — the delivery ledger is the busiest table by row count; its terminal rows (sent/failed/
  // expired/unknown) are history and must age out, but a `held` row is live (awaiting drain) and
  // must survive regardless of age.
  it("prunes terminal deliveries past the window, keeps held + recent", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);
    const dels = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.channel_id, CH));
    expect(dels.map((r) => r.delivery_key).sort()).toEqual(["dk-held-old", "dk-term-recent"]);
  });

  //  — resolved approvals (approved/rejected) are history; a `pending` approval is live work
  // and must never be pruned, no matter how old.
  it("prunes resolved approvals past the window, keeps pending + recent", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);
    const apvs = await db.select().from(s.pendingApprovals).where(eq(s.pendingApprovals.workspace_id, WS));
    expect(apvs.map((r) => r.id).sort()).toEqual([APV_PENDING, APV_RECENT].sort());
  });

  //  — a delivery committed `sending` whose job then crashed AND exhausted its retries before
  // the reconcile ran is stuck `sending` forever (terminal prune skips it). A stuck-sending sweep
  // (well past the retry window) reaps it; a fresh `sending` row is left alone.
  it("prunes a delivery stuck 'sending' past the window, keeps a fresh one", async () => {
    if (!TEST_DB) return;
    await db.insert(s.outboundDeliveries).values([
      { delivery_key: "dk-sending-stuck", workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "sending", payload: {}, updated_at: new Date(NOW.getTime() - 8 * DAY) },
      { delivery_key: "dk-sending-fresh", workspace_id: WS, channel_id: CH, task_name: "outgoing-message", status: "sending", payload: {}, updated_at: new Date(NOW.getTime() - 3_600_000) },
    ]);
    await pruneExpired(NOW);
    const remaining = await db.select().from(s.outboundDeliveries).where(eq(s.outboundDeliveries.status, "sending"));
    expect(remaining.map((r) => r.delivery_key)).toEqual(["dk-sending-fresh"]);
  });

  //  — DB-clock columns (created_at here) must use a UTC cutoff so a non-UTC host doesn't
  // shift the boundary and prune a row that's still inside its TTL.
  describe("timezone safety", () => {
    const ORIGINAL_TZ = process.env.TZ;
    beforeAll(() => { process.env.TZ = "Europe/Warsaw"; });
    afterAll(() => { process.env.TZ = ORIGINAL_TZ; });

    it("keeps a DB-clock processed_event 90 min inside its 60-day TTL on a non-UTC host", async () => {
      if (!TEST_DB) return;
      const KEY = "reaction:maint-int-tz-boundary";
      await db.delete(s.processedEvents).where(eq(s.processedEvents.key, KEY));
      await db.execute(sql`insert into processed_events (key, created_at) values (${KEY}, now() - interval '60 days' + interval '90 minutes')`);

      await pruneExpired(new Date());

      expect(await db.query.processedEvents.findFirst({ where: eq(s.processedEvents.key, KEY) })).toBeDefined();
      await db.delete(s.processedEvents).where(eq(s.processedEvents.key, KEY));
    });
  });
});
