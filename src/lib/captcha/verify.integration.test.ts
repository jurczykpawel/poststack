import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CAPTCHA_HMAC as HMAC, encodeCaptcha, solvedCaptcha } from "../../../tests/fixtures/captcha";
import { sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;

let db: typeof import("@/lib/db").db;
let verifyCaptcha: typeof import("./verify").verifyCaptcha;
let closeQueue: typeof import("@/lib/queue/client").closeQueue;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ALTCHA_HMAC_KEY = HMAC;
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  ({ verifyCaptcha } = await import("./verify"));
  ({ closeQueue } = await import("@/lib/queue/client"));
});

afterAll(async () => {
  if (!TEST_DB) return;
  delete process.env.ALTCHA_HMAC_KEY;
  await db.execute(sql`delete from rate_limit_counters where key like 'altcha:%'`);
  if (closeQueue) await closeQueue();
});

describe("verifyCaptcha (real Postgres)", () => {
  it("accepts a valid solution once, then rejects a second use of the same payload", async () => {
    if (!TEST_DB) return;
    await db.execute(sql`delete from rate_limit_counters where key like 'altcha:%'`);
    const payload = encodeCaptcha(await solvedCaptcha());

    const first = await verifyCaptcha(payload);
    expect(first.success).toBe(true);

    const replay = await verifyCaptcha(payload);
    expect(replay.success).toBe(false);
  });

  it("rejects an expired challenge solution", async () => {
    if (!TEST_DB) return;
    const payload = encodeCaptcha(await solvedCaptcha(new Date(Date.now() - 1000)));
    expect((await verifyCaptcha(payload)).success).toBe(false);
  });

  it("rejects an invalid payload", async () => {
    if (!TEST_DB) return;
    const bad = Buffer.from(
      JSON.stringify({ algorithm: "SHA-256", challenge: "deadbeef", number: 1, salt: "x", signature: "nope" }),
    ).toString("base64");
    expect((await verifyCaptcha(bad)).success).toBe(false);
  });
  it("accepts only one of simultaneous submissions", async () => {
    const payload = encodeCaptcha(await solvedCaptcha());
    const results = await Promise.all([verifyCaptcha(payload), verifyCaptcha(payload)]);
    expect(results.filter((result) => result.success)).toHaveLength(1);
  });

});
