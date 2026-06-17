import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let cfg: typeof import("./config");

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  cfg = await import("./config");
});

beforeEach(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table instance_settings`);
  cfg.invalidateConfigCache();
  // Control the env precisely — CI sets some META_* vars in the job env, so clear all keys this
  // suite reasons about (otherwise a stray env var flips an "unset" assertion to "env").
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_WEBHOOK_VERIFY_TOKEN;
});

afterAll(async () => {
  if (!TEST_DB) return;
  await db.execute(sql`truncate table instance_settings`);
});

describe("instance settings config resolver (real Postgres)", () => {
  it("falls back to the env var when no DB value is set", async () => {
    if (!TEST_DB) return;
    process.env.META_APP_ID = "env-app-id";
    cfg.invalidateConfigCache();
    expect(await cfg.getConfig("META_APP_ID")).toBe("env-app-id");
  });

  it("a DB value overrides the env var; clearing reverts to env", async () => {
    if (!TEST_DB) return;
    process.env.META_APP_ID = "env-app-id";
    await cfg.setConfig("META_APP_ID", "db-app-id");
    expect(await cfg.getConfig("META_APP_ID")).toBe("db-app-id");
    await cfg.clearConfig("META_APP_ID");
    expect(await cfg.getConfig("META_APP_ID")).toBe("env-app-id");
  });

  it("stores secrets encrypted at rest (never plaintext in the row)", async () => {
    if (!TEST_DB) return;
    await cfg.setConfig("META_APP_SECRET", "super-secret-value");
    const rows = await db.execute(sql`select value_encrypted from instance_settings where key = 'META_APP_SECRET'`);
    const stored = (rows.rows[0] as { value_encrypted: string }).value_encrypted;
    expect(stored).not.toContain("super-secret-value"); // encrypted
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/); // iv:tag:ciphertext
    expect(await cfg.getConfig("META_APP_SECRET")).toBe("super-secret-value"); // round-trips
  });

  it("setConfig('') clears (reverts to env), not stores empty", async () => {
    if (!TEST_DB) return;
    await cfg.setConfig("META_APP_ID", "db-app-id");
    await cfg.setConfig("META_APP_ID", "");
    const n = await db.execute(sql`select count(*)::int as n from instance_settings where key = 'META_APP_ID'`);
    expect(Number((n.rows[0] as { n: number }).n)).toBe(0);
  });

  it("rejects an unknown config key", async () => {
    if (!TEST_DB) return;
    await expect(cfg.setConfig("NOT_A_REAL_KEY" as Parameters<typeof cfg.setConfig>[0], "x")).rejects.toThrow(/unknown config key/);
  });

  it("configStatus masks secrets and reports the source; never returns secret plaintext", async () => {
    if (!TEST_DB) return;
    process.env.META_APP_ID = "env-app-id";
    await cfg.setConfig("META_APP_SECRET", "top-secret");
    const status = await cfg.configStatus();
    const appId = status.find((s) => s.key === "META_APP_ID")!;
    const secret = status.find((s) => s.key === "META_APP_SECRET")!;
    const verify = status.find((s) => s.key === "META_WEBHOOK_VERIFY_TOKEN")!;

    expect(appId.source).toBe("env");
    expect(appId.preview).toBe("env-app-id"); // non-secret shown in full

    expect(secret.source).toBe("db");
    expect(secret.preview).not.toContain("top-secret"); // masked
    expect(secret.preview).toContain("set");

    expect(verify.source).toBe("unset");
    expect(verify.preview).toBe("");
  });
});
