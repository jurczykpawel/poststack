import { describe, it, expect, beforeEach, vi } from "vitest";

const mockEnrollmentFindUnique = vi.fn();
const mockEnrollmentUpdate = vi.fn().mockResolvedValue({});
const mockConversationFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    sequenceEnrollment: {
      findUnique: (...a: unknown[]) => mockEnrollmentFindUnique(...a),
      update: (...a: unknown[]) => mockEnrollmentUpdate(...a),
    },
    conversation: { findFirst: (...a: unknown[]) => mockConversationFindFirst(...a) },
  },
}));

const mockAddJob = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/queue/client", () => ({ addJob: (...a: unknown[]) => mockAddJob(...a) }));

import { processSequenceStep } from "./sequence-step-worker";

const helpers = { logger: { info: vi.fn() } } as never;

function enrollment(steps: unknown[], stepIndex = 0) {
  return {
    id: "en-1",
    status: "active",
    current_step_index: stepIndex,
    contact_id: "co-1",
    channel_id: "ch-1",
    sequence: { id: "sq-1", steps },
    contact: { contact_channels: [{ platform_sender_id: "PSID", channel_id: "ch-1" }] },
  };
}

describe("processSequenceStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationFindFirst.mockResolvedValue({ id: "cv-1" });
  });

  it("skips an enrollment that is not active", async () => {
    mockEnrollmentFindUnique.mockResolvedValueOnce({ ...enrollment([]), status: "completed" });
    await processSequenceStep({ enrollmentId: "en-1" }, helpers);
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it("sends a message step and completes when it is the last step", async () => {
    mockEnrollmentFindUnique.mockResolvedValueOnce(enrollment([{ type: "message", content: "Hello" }]));

    await processSequenceStep({ enrollmentId: "en-1" }, helpers);

    const outgoing = mockAddJob.mock.calls.find((c) => c[0] === "outgoing-message");
    expect(outgoing).toBeTruthy();
    expect(outgoing![1]).toMatchObject({ channelId: "ch-1", conversationId: "cv-1", recipientPlatformId: "PSID", content: { text: "Hello" } });
    expect(mockEnrollmentUpdate.mock.calls.at(-1)![0].data.status).toBe("completed");
  });

  it("advances to the next step after a message step", async () => {
    mockEnrollmentFindUnique.mockResolvedValueOnce(
      enrollment([{ type: "message", content: "Hi" }, { type: "message", content: "Bye" }]),
    );

    await processSequenceStep({ enrollmentId: "en-1" }, helpers);

    const next = mockAddJob.mock.calls.find((c) => c[0] === "sequence-step");
    expect(next).toBeTruthy();
    expect(next![1]).toEqual({ enrollmentId: "en-1" });
  });

  it("schedules the next step with a delay for a delay step", async () => {
    mockEnrollmentFindUnique.mockResolvedValueOnce(
      enrollment([{ type: "delay", delay_minutes: 5 }, { type: "message", content: "Later" }]),
    );

    await processSequenceStep({ enrollmentId: "en-1" }, helpers);

    const next = mockAddJob.mock.calls.find((c) => c[0] === "sequence-step");
    expect(next).toBeTruthy();
    expect(next![2]).toEqual({ delayMs: 5 * 60 * 1000 });
    expect(mockEnrollmentUpdate.mock.calls[0][0].data.current_step_index).toBe(1);
  });
});
