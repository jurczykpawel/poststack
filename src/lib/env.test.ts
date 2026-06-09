import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

//  — env/secret validation hardening. loadEnv() runs at module import, so each case
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
});
