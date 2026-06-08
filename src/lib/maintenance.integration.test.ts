import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let s: typeof import("@/db/schema");
let pruneExpired: typeof import("./maintenance").pruneExpired;

const RULE = "aaaaaaaa-0000-0000-0000-0000000000f1";
const CONTACT_OLD = "aaaaaaaa-0000-0000-0000-0000000000f2";
const CONTACT_NEW = "aaaaaaaa-0000-0000-0000-0000000000f3";
const IDEM_OLD = "maint-int-old";
const IDEM_NEW = "maint-int-new";
const JTI_OLD = "maint-int-jti-old";
const JTI_NEW = "maint-int-jti-new";
const RL_OLD = "maint-int-rl-old";
const RL_NEW = "maint-int-rl-new";

const NOW = new Date();
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 3_600_000);

async function cleanup() {
  await db.delete(s.idempotencyKeys).where(inArray(s.idempotencyKeys.key, [IDEM_OLD, IDEM_NEW]));
  await db.delete(s.ruleCooldowns).where(eq(s.ruleCooldowns.rule_id, RULE));
  await db.delete(s.revokedTokens).where(inArray(s.revokedTokens.jti, [JTI_OLD, JTI_NEW]));
  await db.delete(s.rateLimitCounters).where(inArray(s.rateLimitCounters.key, [RL_OLD, RL_NEW]));
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
  await db.insert(s.idempotencyKeys).values([
    { key: IDEM_OLD, expires_at: PAST },
    { key: IDEM_NEW, expires_at: FUTURE },
  ]);
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
});

afterAll(async () => {
  if (TEST_DB) await cleanup();
});

describe("pruneExpired (real Postgres)", () => {
  it("removes expired ephemeral rows and keeps live ones", async () => {
    if (!TEST_DB) return;
    await pruneExpired(NOW);

    const idem = await db.select().from(s.idempotencyKeys).where(inArray(s.idempotencyKeys.key, [IDEM_OLD, IDEM_NEW]));
    expect(idem.map((r) => r.key)).toEqual([IDEM_NEW]);

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
});
