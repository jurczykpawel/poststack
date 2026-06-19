import { describe, it, expect, beforeAll } from "vitest";

// Importing the cron module pulls in the scan (env-validated); give it a valid env.
beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
});

describe("worker cron schedule", () => {
  // the token-refresh scan used to live only behind an HTTP endpoint, so a self-hoster who
  // never wired an external cron would have every OAuth channel silently expire in ~60 days. It
  // must be scheduled in-process alongside the other maintenance tasks.
  it("schedules the token-refresh scan in-process (not just the HTTP trigger)", async () => {
    const { CRONTAB, cronTaskList } = await import("./cron");
    expect(CRONTAB).toMatch(/\btoken-refresh-scan\b/);
    expect(Object.keys(cronTaskList)).toEqual(
      expect.arrayContaining(["prune-expired", "prune-old-messages", "token-refresh-scan"]),
    );
  });

  it("schedules a daily license re-verification", async () => {
    const { CRONTAB, cronTaskList } = await import("./cron");
    expect(CRONTAB).toMatch(/\blicense-refresh\b/);
    expect(Object.keys(cronTaskList)).toContain("license-refresh");
  });

  it("schedules compact-history daily", async () => {
    const { CRONTAB, cronTaskList } = await import("./cron");
    expect(Object.keys(cronTaskList)).toContain("compact-history");
    expect(CRONTAB).toMatch(/compact-history/);
  });

  it("schedules a daily telemetry send", async () => {
    const { CRONTAB, cronTaskList } = await import("./cron");
    expect(Object.keys(cronTaskList)).toContain("telemetry-send");
    expect(CRONTAB).toMatch(/\btelemetry-send\b/);
  });

  it("every crontab entry references a task that exists in the task list", async () => {
    const { CRONTAB, cronTaskList } = await import("./cron");
    const scheduled = CRONTAB.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).pop());
    for (const task of scheduled) {
      expect(Object.keys(cronTaskList)).toContain(task);
    }
  });
});
