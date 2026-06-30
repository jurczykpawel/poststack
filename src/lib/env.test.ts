import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// env/secret validation hardening. loadEnv() runs at module import, so each case
// resets the module registry and re-imports with a tailored process.env.

const GOOD: Record<string, string> = {
  DATABASE_URL: "postgres://localhost/x",
  JWT_SECRET: "x".repeat(32),
  CRON_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "a".repeat(40), // any passphrase >= 32 chars (sha256-derived)
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  vi.resetModules();
});
afterEach(() => {
  process.env = saved;
});

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries({ ...GOOD, ...over })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("env validation", () => {
  it("accepts any passphrase >= 32 chars as ENCRYPTION_KEY (no hex constraint)", async () => {
    setEnv({ ENCRYPTION_KEY: "a non-hex but plenty long passphrase!!" });
    const { env } = await import("@/lib/env");
    expect(env.ENCRYPTION_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects an ENCRYPTION_KEY shorter than 32 chars at startup (not deferred to first use)", async () => {
    setEnv({ ENCRYPTION_KEY: "too-short" });
    await expect(import("@/lib/env")).rejects.toThrow();
  });

  it("no longer bypasses validation under NEXT_PHASE (dead Next guard removed)", async () => {
    setEnv({ ENCRYPTION_KEY: undefined });
    process.env.NEXT_PHASE = "phase-production-build";
    try {
      await expect(import("@/lib/env")).rejects.toThrow();
    } finally {
      delete process.env.NEXT_PHASE;
    }
  });

  // the optional channel-alert webhook is validated at boot so a private/link-local
  // target can't be configured and then fetched at runtime.
  it("accepts a public https CHANNEL_ALERT_WEBHOOK_URL", async () => {
    setEnv({ CHANNEL_ALERT_WEBHOOK_URL: "https://hooks.example.com/alert" });
    const { env } = await import("@/lib/env");
    expect(env.CHANNEL_ALERT_WEBHOOK_URL).toBe("https://hooks.example.com/alert");
  });

  it("rejects a private/link-local CHANNEL_ALERT_WEBHOOK_URL at startup", async () => {
    setEnv({ CHANNEL_ALERT_WEBHOOK_URL: "http://169.254.169.254/latest/meta-data/" });
    await expect(import("@/lib/env")).rejects.toThrow();
  });

  // AIDRAFT1 / Task 9: per-workspace daily budget for AI-draft generation. Default 0 = unlimited
  // (BYOK / self-hosted). The worker reads env.AI_DRAFT_DAILY_LIMIT; 0 ⇒ no rate-limit call at all.
  it("AI_DRAFT_DAILY_LIMIT defaults to 0 (unlimited) when unset", async () => {
    setEnv({ AI_DRAFT_DAILY_LIMIT: undefined });
    const { env } = await import("@/lib/env");
    expect(env.AI_DRAFT_DAILY_LIMIT).toBe(0);
  });

  it("coerces a numeric AI_DRAFT_DAILY_LIMIT from its string env value", async () => {
    setEnv({ AI_DRAFT_DAILY_LIMIT: "50" });
    const { env } = await import("@/lib/env");
    expect(env.AI_DRAFT_DAILY_LIMIT).toBe(50);
  });

  it("rejects a negative AI_DRAFT_DAILY_LIMIT at startup", async () => {
    setEnv({ AI_DRAFT_DAILY_LIMIT: "-1" });
    await expect(import("@/lib/env")).rejects.toThrow();
  });
});

// surface a startup warning for security-lax-but-valid production config rather than
// failing silently: unset ALTCHA_HMAC_KEY (CAPTCHA skipped) and TRUSTED_PROXY (per-IP rate-limit
// collapse). Dev is unaffected.
describe("production startup warnings", () => {
  const warnMessages = () => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when ALTCHA_HMAC_KEY and TRUSTED_PROXY are unset in production", async () => {
    setEnv({ NODE_ENV: "production", ALTCHA_HMAC_KEY: undefined, TRUSTED_PROXY: undefined });
    await import("@/lib/env");
    expect(warnMessages()).toMatch(/ALTCHA_HMAC_KEY/);
    expect(warnMessages()).toMatch(/TRUSTED_PROXY/);
  });

  it("does not warn when they are set in production", async () => {
    setEnv({ NODE_ENV: "production", ALTCHA_HMAC_KEY: "k".repeat(32), TRUSTED_PROXY: "cloudflare" });
    await import("@/lib/env");
    expect(warnMessages()).not.toMatch(/ALTCHA_HMAC_KEY|TRUSTED_PROXY/);
  });

  it("does not warn in development even when unset", async () => {
    setEnv({ NODE_ENV: "development", ALTCHA_HMAC_KEY: undefined, TRUSTED_PROXY: undefined });
    await import("@/lib/env");
    expect(warnMessages()).not.toMatch(/ALTCHA_HMAC_KEY|TRUSTED_PROXY/);
  });
});
