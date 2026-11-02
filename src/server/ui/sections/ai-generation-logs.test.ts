import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let aiLogLocked: typeof import("./ai-generation-logs").aiLogLocked;
let renderAiLogSummary: typeof import("./ai-generation-logs").renderAiLogSummary;

beforeAll(async () => {
  ({ aiLogLocked, renderAiLogSummary } = await import("./ai-generation-logs"));
});

describe("AI log gating", () => {
  it("shows a PRO prompt with the upgrade link when the instance is not entitled", () => {
    const out = String(aiLogLocked("/pricing"));
    expect(out).toContain("PRO");
    expect(out).toContain("/pricing");
  });

  it("Settings summary of an unentitled instance is the same prompt and never reads the log", async () => {
    const out = String(await renderAiLogSummary("00000000-0000-4000-8000-000000000000", false, "/pricing"));
    expect(out).toContain("/pricing");
    expect(out).not.toContain("/activity?source=ai");
  });
});
