import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/workers/incoming-message-worker", () => ({ processIncomingMessage: vi.fn() }));
vi.mock("@/lib/workers/incoming-comment-worker", () => ({ processIncomingComment: vi.fn() }));
vi.mock("@/lib/workers/incoming-reaction-worker", () => ({ processIncomingReaction: vi.fn() }));
vi.mock("@/lib/workers/outgoing-message-worker", () => ({ processOutgoingMessage: vi.fn() }));
vi.mock("@/lib/workers/outgoing-comment-worker", () => ({ processOutgoingComment: vi.fn() }));
vi.mock("@/lib/workers/outgoing-private-reply-worker", () => ({ processOutgoingPrivateReply: vi.fn() }));
vi.mock("@/lib/workers/follow-gate-worker", () => ({ processFollowGate: vi.fn() }));
vi.mock("@/lib/workers/token-refresh-worker", () => ({ processTokenRefresh: vi.fn() }));
vi.mock("@/lib/workers/sequence-step-worker", () => ({ processSequenceStep: vi.fn() }));
vi.mock("@/lib/channels/drain", () => ({ drainChannel: vi.fn() }));

import { createTaskList } from "./tasks";

const EXPECTED_TASKS = [
  "incoming-message",
  "incoming-comment",
  "incoming-reaction",
  "outgoing-message",
  "outgoing-comment",
  "outgoing-private-reply",
  "follow-gate",
  "token-refresh",
  "sequence-step",
  "drain-channel",
];

describe("createTaskList", () => {
  it("registers exactly the known tasks", () => {
    expect(Object.keys(createTaskList()).sort()).toEqual([...EXPECTED_TASKS].sort());
  });

  it("maps every task to a callable handler", () => {
    const list = createTaskList();
    for (const name of EXPECTED_TASKS) {
      expect(typeof list[name]).toBe("function");
    }
  });

  it("forwards payload and helpers to the underlying worker", async () => {
    const { processTokenRefresh } = await import("@/lib/workers/token-refresh-worker");
    const list = createTaskList();
    const payload = { channelId: "ch-1" };
    const helpers = { logger: { info: vi.fn() } };

    await (list["token-refresh"] as (p: unknown, h: unknown) => unknown)(payload, helpers);

    expect(processTokenRefresh).toHaveBeenCalledWith(payload, helpers);
  });
});
