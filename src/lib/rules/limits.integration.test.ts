import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let acquireCooldown: typeof import("./limits").acquireCooldown;
let incrementSendCount: typeof import("./limits").incrementSendCount;

const RULE = "11111111-1111-1111-1111-111111111111";
const CONTACT = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  ({ db } = await import("@/lib/db"));
  ({ acquireCooldown, incrementSendCount } = await import("./limits"));
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql.raw("truncate table rule_cooldowns, rule_send_counts"));
});

afterAll(async () => {
  if (db) await db.$client.end();
});

describe("acquireCooldown (real Postgres, atomic acquire-or-skip)", () => {
  it("acquires the first time, then blocks while cooling down", async () => {
    if (!TEST_DB) return;
    expect(await acquireCooldown(RULE, CONTACT, 60)).toBe(true);
    expect(await acquireCooldown(RULE, CONTACT, 60)).toBe(false);
  });

  it("re-acquires once the previous cooldown has expired", async () => {
    if (!TEST_DB) return;
    expect(await acquireCooldown(RULE, CONTACT, 60)).toBe(true);
    await db.execute(sql.raw("update rule_cooldowns set expires_at = now() - interval '1 second'"));
    expect(await acquireCooldown(RULE, CONTACT, 60)).toBe(true);
  });

  it("is a no-op (always true) when cooldownSeconds <= 0", async () => {
    if (!TEST_DB) return;
    expect(await acquireCooldown(RULE, CONTACT, 0)).toBe(true);
    expect(await acquireCooldown(RULE, CONTACT, 0)).toBe(true);
  });

  it("lets exactly one of many concurrent acquirers win", async () => {
    if (!TEST_DB) return;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireCooldown(RULE, CONTACT, 60)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("incrementSendCount (real Postgres, atomic increment-if-under-cap)", () => {
  it("fires up to the cap then blocks", async () => {
    if (!TEST_DB) return;
    expect(await incrementSendCount(RULE, CONTACT, 3)).toBe(true);
    expect(await incrementSendCount(RULE, CONTACT, 3)).toBe(true);
    expect(await incrementSendCount(RULE, CONTACT, 3)).toBe(true);
    expect(await incrementSendCount(RULE, CONTACT, 3)).toBe(false);
  });

  it("never fires when the cap is 0 or less", async () => {
    if (!TEST_DB) return;
    expect(await incrementSendCount(RULE, CONTACT, 0)).toBe(false);
  });

  it("allows exactly `max` successes across concurrent callers", async () => {
    if (!TEST_DB) return;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => incrementSendCount(RULE, CONTACT, 3)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});
