import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/workers/incoming-message-worker", () => ({ processIncomingMessage: vi.fn() }));
vi.mock("@/lib/workers/incoming-comment-worker", () => ({ processIncomingComment: vi.fn() }));
vi.mock("@/lib/workers/incoming-reaction-worker", () => ({ processIncomingReaction: vi.fn() }));
vi.mock("@/lib/workers/incoming-post-reaction-worker", () => ({ processIncomingPostReaction: vi.fn() }));
vi.mock("@/lib/workers/outgoing-message-worker", () => ({ processOutgoingMessage: vi.fn() }));
vi.mock("@/lib/workers/outgoing-comment-worker", () => ({ processOutgoingComment: vi.fn() }));
vi.mock("@/lib/workers/outgoing-first-comment-worker", () => ({ processOutgoingFirstComment: vi.fn() }));
vi.mock("@/lib/workers/publish-story-worker", () => ({ processPublishStory: vi.fn() }));
vi.mock("@/lib/workers/incoming-echo-worker", () => ({ processIncomingEcho: vi.fn() }));
vi.mock("@/lib/workers/incoming-receipt-worker", () => ({ processIncomingReceipt: vi.fn() }));
vi.mock("@/lib/workers/outgoing-private-reply-worker", () => ({ processOutgoingPrivateReply: vi.fn() }));
vi.mock("@/lib/workers/follow-gate-worker", () => ({ processFollowGate: vi.fn() }));
vi.mock("@/lib/workers/token-refresh-worker", () => ({ processTokenRefresh: vi.fn() }));
vi.mock("@/lib/workers/sequence-step-worker", () => ({ processSequenceStep: vi.fn() }));
vi.mock("@/lib/channels/drain", () => ({ drainChannel: vi.fn() }));
vi.mock("@/lib/sequences/resume", () => ({ resumeChannelEnrollments: vi.fn() }));
vi.mock("@/lib/deliveries/publish-worker", () => ({ processPublish: vi.fn() }));
vi.mock("@/lib/webhooks/dispatch", () => ({ processEventDispatch: vi.fn(), processWebhookDelivery: vi.fn() }));

import { createTaskList } from "./tasks";

const EXPECTED_TASKS = [
  "incoming-message",
  "incoming-comment",
  "incoming-reaction",
  "incoming-post-reaction",
  "outgoing-message",
  "outgoing-comment",
  "outgoing-first-comment",
  "publish-story",
  "incoming-echo",
  "incoming-receipt",
  "outgoing-private-reply",
  "follow-gate",
  "token-refresh",
  "sequence-step",
  "drain-channel",
  "resume-channel-enrollments",
  "publish",
  "event-dispatch",
  "webhook-delivery",
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
