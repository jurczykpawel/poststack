import { describe, it, expect, beforeEach, vi } from "vitest";

const mockChannelFindUnique = vi.fn();
const mockMessageFindMany = vi.fn();
const mockMessageUpdate = vi.fn().mockResolvedValue({});
const mockContactChannelFindFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findUnique: (...a: unknown[]) => mockChannelFindUnique(...a) },
    message: {
      findMany: (...a: unknown[]) => mockMessageFindMany(...a),
      update: (...a: unknown[]) => mockMessageUpdate(...a),
    },
    contactChannel: { findFirst: (...a: unknown[]) => mockContactChannelFindFirst(...a) },
  },
}));

const mockAddJob = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/queue/client", () => ({ addJob: (...a: unknown[]) => mockAddJob(...a) }));

import { drainChannel } from "./drain";

const now = new Date("2026-06-05T12:00:00.000Z");
const withinWindow = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
const outsideWindow = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago

function heldMsg(id: string, last_inbound_at: Date | null) {
  return {
    id,
    text: `text-${id}`,
    sent_by_rule_id: "rule-1",
    conversation: { id: "cv-1", contact_id: "co-1", last_inbound_at },
  };
}

describe("drainChannel — REL5 replay of held messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContactChannelFindFirst.mockResolvedValue({ platform_sender_id: "PSID" });
  });

  it("does not drain a channel that is not active (breaker still open)", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "needs_reauth" });

    const result = await drainChannel("ch-1", now);

    expect(result).toEqual({ enqueued: 0, expired: 0, skipped: "needs_reauth" });
    expect(mockMessageFindMany).not.toHaveBeenCalled();
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it("re-enqueues a held message inside the messaging window (carrying heldMessageId)", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "active" });
    mockMessageFindMany.mockResolvedValueOnce([heldMsg("m1", withinWindow)]);

    const result = await drainChannel("ch-1", now);

    expect(result).toEqual({ enqueued: 1, expired: 0 });
    expect(mockAddJob).toHaveBeenCalledTimes(1);
    const [task, payload, opts] = mockAddJob.mock.calls[0];
    expect(task).toBe("outgoing-message");
    expect(payload).toMatchObject({
      channelId: "ch-1",
      conversationId: "cv-1",
      recipientPlatformId: "PSID",
      heldMessageId: "m1",
      idempotencyKey: "held:m1",
    });
    expect(opts.jobKey).toBe("drain-msg:m1");
    expect(mockMessageUpdate).not.toHaveBeenCalled();
  });

  it("expires a held message past the window instead of sending it", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "active" });
    mockMessageFindMany.mockResolvedValueOnce([heldMsg("m2", outsideWindow)]);

    const result = await drainChannel("ch-1", now);

    expect(result).toEqual({ enqueued: 0, expired: 1 });
    expect(mockAddJob).not.toHaveBeenCalled();
    expect(mockMessageUpdate).toHaveBeenCalledWith({ where: { id: "m2" }, data: { status: "expired" } });
  });

  it("expires a held message with no window anchor (no known inbound)", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "active" });
    mockMessageFindMany.mockResolvedValueOnce([heldMsg("m3", null)]);

    const result = await drainChannel("ch-1", now);

    expect(result.expired).toBe(1);
    expect(mockMessageUpdate).toHaveBeenCalledWith({ where: { id: "m3" }, data: { status: "expired" } });
  });

  it("throttles the drain by staggering enqueue delays in created order", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ id: "ch-1", status: "active" });
    mockMessageFindMany.mockResolvedValueOnce([heldMsg("m1", withinWindow), heldMsg("m2", withinWindow)]);

    await drainChannel("ch-1", now);

    expect(mockAddJob).toHaveBeenCalledTimes(2);
    const firstDelay = mockAddJob.mock.calls[0][2].delayMs;
    const secondDelay = mockAddJob.mock.calls[1][2].delayMs;
    expect(secondDelay).toBeGreaterThan(firstDelay);
  });
});
