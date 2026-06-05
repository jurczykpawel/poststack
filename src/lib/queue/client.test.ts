import { describe, it, expect, beforeAll, vi } from "vitest";

const mockUtilsAddJob = vi.fn().mockResolvedValue({});
const mockMakeWorkerUtils = vi.fn().mockResolvedValue({ addJob: mockUtilsAddJob });
vi.mock("graphile-worker", () => ({
  makeWorkerUtils: (...args: unknown[]) => mockMakeWorkerUtils(...args),
}));

beforeAll(() => {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
});

// Imported once; the module holds a singleton WorkerUtils promise we want to observe.
import { addJob } from "./client";

describe("addJob", () => {
  it("delegates to WorkerUtils.addJob with task name, payload, and the computed spec", async () => {
    const payload = { channelId: "c1", conversationId: "cv1" };

    await addJob("outgoing-message", payload as never, { jobKey: "k1" });

    expect(mockUtilsAddJob).toHaveBeenCalledTimes(1);
    const [task, forwardedPayload, spec] = mockUtilsAddJob.mock.calls[0];
    expect(task).toBe("outgoing-message");
    expect(forwardedPayload).toBe(payload);
    expect(spec.maxAttempts).toBe(3); // parity default for outgoing-message
    expect(spec.jobKey).toBe("k1");
  });

  it("reuses a single WorkerUtils instance across calls (singleton pool)", async () => {
    await addJob("incoming-message", {} as never);
    await addJob("incoming-message", {} as never);

    // makeWorkerUtils created the instance during the first test and is never called again.
    expect(mockMakeWorkerUtils).toHaveBeenCalledTimes(1);
    expect(mockMakeWorkerUtils).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: expect.any(String) }),
    );
  });
});
