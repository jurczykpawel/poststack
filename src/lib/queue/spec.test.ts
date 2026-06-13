import { describe, it, expect } from "vitest";
import { buildTaskSpec, TASK_MAX_ATTEMPTS } from "./spec";
import type { TaskName } from "./types";

const ALL_TASKS: TaskName[] = [
  "incoming-message",
  "incoming-comment",
  "incoming-reaction",
  "incoming-post-reaction",
  "outgoing-message",
  "outgoing-comment",
  "outgoing-private-reply",
  "follow-gate",
  "token-refresh",
  "sequence-step",
  "drain-channel",
  "resume-channel-enrollments",
  "publish",
];

describe("TASK_MAX_ATTEMPTS — retry parity with former BullMQ config", () => {
  it("defines a retry count for every task (no task left undefined)", () => {
    expect(Object.keys(TASK_MAX_ATTEMPTS).sort()).toEqual([...ALL_TASKS].sort());
  });

  it("gives outgoing tasks 3 attempts (was attempts:3 in BullMQ)", () => {
    expect(TASK_MAX_ATTEMPTS["outgoing-message"]).toBe(3);
    expect(TASK_MAX_ATTEMPTS["outgoing-comment"]).toBe(3);
  });

  it("gives sequence-step 3 attempts (was attempts:3 in BullMQ)", () => {
    expect(TASK_MAX_ATTEMPTS["sequence-step"]).toBe(3);
  });

  it("retries every task type on transient failure (: incoming/token-refresh no longer single-attempt)", () => {
    expect(TASK_MAX_ATTEMPTS["incoming-message"]).toBe(3);
    expect(TASK_MAX_ATTEMPTS["incoming-comment"]).toBe(3);
    expect(TASK_MAX_ATTEMPTS["token-refresh"]).toBe(3);
  });
});

describe("buildTaskSpec", () => {
  it("applies the per-task default maxAttempts", () => {
    expect(buildTaskSpec("outgoing-message").maxAttempts).toBe(3);
    expect(buildTaskSpec("incoming-message").maxAttempts).toBe(3);
  });

  it("lets an explicit maxAttempts override the default", () => {
    expect(buildTaskSpec("incoming-message", { maxAttempts: 5 }).maxAttempts).toBe(5);
  });

  it("passes jobKey through for dedup (was BullMQ jobId)", () => {
    expect(buildTaskSpec("incoming-message", { jobKey: "msg-123" }).jobKey).toBe("msg-123");
  });

  it("omits jobKey when none given", () => {
    expect(buildTaskSpec("incoming-message").jobKey).toBeUndefined();
  });

  it("translates delayMs into a runAt relative to now (was BullMQ delay)", () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    const spec = buildTaskSpec("sequence-step", { delayMs: 5000 }, now);
    expect(spec.runAt).toEqual(new Date("2026-06-05T12:00:05.000Z"));
  });

  it("omits runAt when delayMs is 0 or absent (run immediately)", () => {
    const now = new Date("2026-06-05T12:00:00.000Z");
    expect(buildTaskSpec("sequence-step", { delayMs: 0 }, now).runAt).toBeUndefined();
    expect(buildTaskSpec("sequence-step", {}, now).runAt).toBeUndefined();
  });
});
