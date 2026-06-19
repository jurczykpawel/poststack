import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Telemetry is ON by default (n8n-style opt-out). Either POSTSTACK_TELEMETRY_DISABLED=true or
// POSTSTACK_TELEMETRY_ENABLED=false turns it off. env.ts resolves both to a single TELEMETRY_ENABLED
// boolean. loadEnv() runs at import, so each case re-imports with a tailored process.env.

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
  for (const k of ["POSTSTACK_TELEMETRY_DISABLED", "POSTSTACK_TELEMETRY_ENABLED", "TELEMETRY_URL"]) {
    if (!(k in over)) delete process.env[k];
  }
}

describe("telemetry env resolution", () => {
  it("is enabled by default (no flags set)", async () => {
    setEnv({});
    const { env } = await import("@/lib/env");
    expect(env.TELEMETRY_ENABLED).toBe(true);
  });

  it("POSTSTACK_TELEMETRY_DISABLED=true disables it", async () => {
    setEnv({ POSTSTACK_TELEMETRY_DISABLED: "true" });
    const { env } = await import("@/lib/env");
    expect(env.TELEMETRY_ENABLED).toBe(false);
  });

  it("POSTSTACK_TELEMETRY_ENABLED=false disables it", async () => {
    setEnv({ POSTSTACK_TELEMETRY_ENABLED: "false" });
    const { env } = await import("@/lib/env");
    expect(env.TELEMETRY_ENABLED).toBe(false);
  });

  it("stays enabled when the flags explicitly say so", async () => {
    setEnv({ POSTSTACK_TELEMETRY_DISABLED: "false", POSTSTACK_TELEMETRY_ENABLED: "true" });
    const { env } = await import("@/lib/env");
    expect(env.TELEMETRY_ENABLED).toBe(true);
  });

  it("is off if EITHER flag opts out, even when the other says on", async () => {
    setEnv({ POSTSTACK_TELEMETRY_DISABLED: "true", POSTSTACK_TELEMETRY_ENABLED: "true" });
    const { env } = await import("@/lib/env");
    expect(env.TELEMETRY_ENABLED).toBe(false);
  });

  it("defaults TELEMETRY_URL and accepts an override", async () => {
    setEnv({});
    const def = (await import("@/lib/env")).env;
    expect(def.TELEMETRY_URL).toBe("https://telemetry.techskills.academy/v1/ingest");

    vi.resetModules();
    setEnv({ TELEMETRY_URL: "https://example.test/ingest" });
    const over = (await import("@/lib/env")).env;
    expect(over.TELEMETRY_URL).toBe("https://example.test/ingest");
  });
});
