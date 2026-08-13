import { describe, expect, it } from "vitest";
import { WorkerHeartbeat } from "./heartbeat";

describe("worker heartbeat", () => {
  it("advances while a long-running job keeps the event loop responsive", () => {
    let now = 10_000;
    const heartbeat = new WorkerHeartbeat(() => now);

    heartbeat.jobStarted();
    now = 100_000;

    expect(heartbeat.timestampSeconds()).toBe(100);
  });

  it("freezes without active jobs until a successful database interaction", () => {
    let now = 10_000;
    const heartbeat = new WorkerHeartbeat(() => now);

    now = 100_000;
    expect(heartbeat.timestampSeconds()).toBe(10);

    heartbeat.databaseReached();
    expect(heartbeat.timestampSeconds()).toBe(100);
  });

  it("returns to database-backed liveness after all concurrent jobs finish", () => {
    let now = 10_000;
    const heartbeat = new WorkerHeartbeat(() => now);

    heartbeat.jobStarted();
    heartbeat.jobStarted();
    now = 50_000;
    heartbeat.jobCompleted();
    expect(heartbeat.timestampSeconds()).toBe(50);

    heartbeat.jobCompleted();
    now = 100_000;
    expect(heartbeat.timestampSeconds()).toBe(50);
  });

  it("never underflows when completion events are repeated", () => {
    let now = 10_000;
    const heartbeat = new WorkerHeartbeat(() => now);

    heartbeat.jobCompleted();
    now = 20_000;

    expect(heartbeat.timestampSeconds()).toBe(10);
  });
});
