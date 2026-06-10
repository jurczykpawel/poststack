import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// env/secret validation hardening. loadEnv() runs at module import, so each case
// resets the module registry and re-imports with a tailored process.env.

const GOOD: Record<string, string> = {
  DATABASE_URL: "postgres://localhost/x",
  JWT_SECRET: "x".repeat(32),
  CRON_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  TOKEN_ENCRYPTION_KEY: "a".repeat(64), // valid 64-char hex
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
  it("accepts a valid 64-char hex TOKEN_ENCRYPTION_KEY", async () => {
    setEnv({});
    const { env } = await import("@/lib/env");
    expect(env.TOKEN_ENCRYPTION_KEY).toHaveLength(64);
  });

  it("rejects a 64-char NON-hex TOKEN_ENCRYPTION_KEY at startup (not deferred to first use)", async () => {
    setEnv({ TOKEN_ENCRYPTION_KEY: "G".repeat(64) });
    await expect(import("@/lib/env")).rejects.toThrow();
  });

  it("no longer bypasses validation under NEXT_PHASE (dead Next guard removed)", async () => {
    setEnv({ TOKEN_ENCRYPTION_KEY: undefined });
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
