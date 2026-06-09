import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let pruneExpired: typeof import("./maintenance").pruneExpired;

const WS = "aaaaaaaa-0000-0000-0000-0000000000f0";
const RULE = "aaaaaaaa-0000-0000-0000-0000000000f1";
const CONTACT_OLD = "aaaaaaaa-0000-0000-0000-0000000000f2";
const CONTACT_NEW = "aaaaaaaa-0000-0000-0000-0000000000f3";
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
});
