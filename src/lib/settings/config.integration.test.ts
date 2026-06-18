import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";

const TEST_DB = process.env.TEST_DATABASE_URL;
let db: typeof import("@/lib/db").db;
let cfg: typeof import("./config");
let instanceSettings: typeof import("@/db/schema").instanceSettings;
let encryptString: typeof import("@/lib/crypto").encryptString;

beforeAll(async () => {
  if (!TEST_DB) return;
  process.env.DATABASE_URL = TEST_DB;
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ db } = await import("@/lib/db"));
  cfg = await import("./config");
  ({ instanceSettings } = await import("@/db/schema"));
  ({ encryptString } = await import("@/lib/crypto"));
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
  // Non-Meta groups (CONFIG1) exercised below — clear so a stray CI env var can't flip an assertion.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.AI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.OPENAI_API_KEY; // legacy alias
  delete process.env.OPENAI_BASE_URL; // legacy alias
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

  // CONFIG1: the same resolver/masking invariants must hold for the non-Meta groups too.
  it("a non-secret non-Meta key (GOOGLE_CLIENT_ID): DB overrides env, shown in full, clears to env", async () => {
    if (!TEST_DB) return;
    process.env.GOOGLE_CLIENT_ID = "env-google-id";
    cfg.invalidateConfigCache();
    expect(await cfg.getConfig("GOOGLE_CLIENT_ID")).toBe("env-google-id");

    await cfg.setConfig("GOOGLE_CLIENT_ID", "db-google-id");
    expect(await cfg.getConfig("GOOGLE_CLIENT_ID")).toBe("db-google-id");

    const status = await cfg.configStatus();
    const google = status.find((s) => s.key === "GOOGLE_CLIENT_ID")!;
    expect(google.source).toBe("db");
    expect(google.secret).toBe(false);
    expect(google.preview).toBe("db-google-id"); // non-secret shown in full

    await cfg.clearConfig("GOOGLE_CLIENT_ID");
    expect(await cfg.getConfig("GOOGLE_CLIENT_ID")).toBe("env-google-id");
  });

  it("a secret non-Meta key (AI_API_KEY) round-trips encrypted and is masked, never plaintext", async () => {
    if (!TEST_DB) return;
    await cfg.setConfig("AI_API_KEY", "sk-super-secret");
    // encrypted at rest
    const rows = await db.execute(sql`select value_encrypted from instance_settings where key = 'AI_API_KEY'`);
    const stored = (rows.rows[0] as { value_encrypted: string }).value_encrypted;
    expect(stored).not.toContain("sk-super-secret");
    // round-trips for the consumer
    expect(await cfg.getConfig("AI_API_KEY")).toBe("sk-super-secret");
    // masked in the UI status — plaintext NEVER returned
    const key = (await cfg.configStatus()).find((s) => s.key === "AI_API_KEY")!;
    expect(key.source).toBe("db");
    expect(key.secret).toBe(true);
    expect(key.preview).not.toContain("sk-super-secret");
    expect(key.preview).toContain("set");
  });

  // AIPROV1: a renamed key (AI_API_KEY ← OPENAI_API_KEY) must still resolve from legacy config so
  // existing deployments keep working, while a fresh save migrates the legacy storage away.
  describe("legacy alias resolution (AI_API_KEY ← OPENAI_API_KEY)", () => {
    it("resolves from a legacy ENV var when the canonical one is unset", async () => {
      if (!TEST_DB) return;
      process.env.OPENAI_API_KEY = "sk-legacy-env";
      cfg.invalidateConfigCache();
      expect(await cfg.getConfig("AI_API_KEY")).toBe("sk-legacy-env");
      const status = (await cfg.configStatus()).find((s) => s.key === "AI_API_KEY")!;
      expect(status.source).toBe("env");
    });

    it("resolves from a legacy DB row (stored under the old key name)", async () => {
      if (!TEST_DB) return;
      await db.insert(instanceSettings).values({ key: "OPENAI_API_KEY", value_encrypted: encryptString("sk-legacy-db"), updated_at: new Date() });
      cfg.invalidateConfigCache();
      expect(await cfg.getConfig("AI_API_KEY")).toBe("sk-legacy-db");
      const status = (await cfg.configStatus()).find((s) => s.key === "AI_API_KEY")!;
      expect(status.source).toBe("db");
    });

    it("the canonical key wins over a legacy value, and saving migrates the legacy row away", async () => {
      if (!TEST_DB) return;
      await db.insert(instanceSettings).values({ key: "OPENAI_API_KEY", value_encrypted: encryptString("sk-legacy"), updated_at: new Date() });
      await cfg.setConfig("AI_API_KEY", "sk-new");
      // canonical value resolves…
      expect(await cfg.getConfig("AI_API_KEY")).toBe("sk-new");
      // …and the legacy row is gone (so it can't resurface on a later clear).
      const legacy = await db.execute(sql`select count(*)::int as n from instance_settings where key = 'OPENAI_API_KEY'`);
      expect(Number((legacy.rows[0] as { n: number }).n)).toBe(0);
    });

    it("clearing the canonical key also removes a stale legacy DB row → falls back to env", async () => {
      if (!TEST_DB) return;
      process.env.OPENAI_API_KEY = "sk-env-fallback";
      await db.insert(instanceSettings).values({ key: "AI_API_KEY", value_encrypted: encryptString("sk-db"), updated_at: new Date() });
      await db.insert(instanceSettings).values({ key: "OPENAI_API_KEY", value_encrypted: encryptString("sk-stale-legacy-db"), updated_at: new Date() });
      await cfg.clearConfig("AI_API_KEY");
      const n = await db.execute(sql`select count(*)::int as n from instance_settings where key in ('AI_API_KEY','OPENAI_API_KEY')`);
      expect(Number((n.rows[0] as { n: number }).n)).toBe(0);
      expect(await cfg.getConfig("AI_API_KEY")).toBe("sk-env-fallback");
    });
  });
});
