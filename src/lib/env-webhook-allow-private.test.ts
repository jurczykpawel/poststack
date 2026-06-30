import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// WEBHOOK_ALLOW_PRIVATE_TARGETS gates whether webhook delivery may target private/loopback/LAN
// addresses. Secure-by-default: OFF unless the raw flag is truthy. env.ts resolves the raw string
// into a single boolean. loadEnv() runs at import, so each case re-imports with a tailored env.

const GOOD: Record<string, string> = {
  DATABASE_URL: "postgres://localhost/x",
  JWT_SECRET: "x".repeat(32),
  CRON_SECRET: "x".repeat(32),
  APP_URL: "http://localhost:3000",
  ENCRYPTION_KEY: "a".repeat(40),
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
  if (!("WEBHOOK_ALLOW_PRIVATE_TARGETS" in over)) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
}

describe("WEBHOOK_ALLOW_PRIVATE_TARGETS env resolution", () => {
  it("defaults to false when unset (secure-by-default)", async () => {
    setEnv({});
    const { env } = await import("@/lib/env");
    expect(env.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(false);
  });

  it('resolves to true when raw value is "true"', async () => {
    setEnv({ WEBHOOK_ALLOW_PRIVATE_TARGETS: "true" });
    const { env } = await import("@/lib/env");
    expect(env.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(true);
  });

  it('resolves to false when raw value is "false"', async () => {
    setEnv({ WEBHOOK_ALLOW_PRIVATE_TARGETS: "false" });
    const { env } = await import("@/lib/env");
    expect(env.WEBHOOK_ALLOW_PRIVATE_TARGETS).toBe(false);
  });
});
