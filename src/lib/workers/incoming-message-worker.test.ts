import { describe, it, expect, beforeEach, vi } from "vitest";

const mockChannelFindFirst = vi.fn();
const mockContactChannelFindUnique = vi.fn();
const mockContactUpdate = vi.fn().mockResolvedValue({});
const mockConversationUpsert = vi.fn();
const mockConversationUpdate = vi.fn().mockResolvedValue({});
const mockMessageCreate = vi.fn().mockResolvedValue({});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findFirst: (...a: unknown[]) => mockChannelFindFirst(...a) },
    contactChannel: { findUnique: (...a: unknown[]) => mockContactChannelFindUnique(...a) },
    contact: { update: (...a: unknown[]) => mockContactUpdate(...a) },
    conversation: {
      upsert: (...a: unknown[]) => mockConversationUpsert(...a),
      update: (...a: unknown[]) => mockConversationUpdate(...a),
    },
    message: { create: (...a: unknown[]) => mockMessageCreate(...a) },
  },
}));

vi.mock("@/generated/prisma/client", () => ({ Prisma: { PrismaClientKnownRequestError: class {} } }));

const mockEvaluateRules = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/rules/executor", () => ({
  evaluateRules: (...a: unknown[]) => mockEvaluateRules(...a),
}));

import { processIncomingMessage } from "./incoming-message-worker";

const helpers = { logger: { info: vi.fn() } } as never;

describe("processIncomingMessage — messaging window anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelFindFirst.mockResolvedValue({ id: "ch-1", workspace_id: "ws-1", platform: "instagram" });
    mockContactChannelFindUnique.mockResolvedValue({ contact_id: "co-1" });
    mockConversationUpsert.mockResolvedValue({ id: "cv-1", is_automation_paused: true });
  });

  it("stamps last_inbound_at (window anchor) from the inbound timestamp", async () => {
    const timestamp = 1_770_000_000; // seconds
    const expected = new Date(timestamp * 1000);

    await processIncomingMessage(
      { pageId: "PG", senderId: "S", mid: "m1", text: "hi", timestamp } as never,
      helpers,
    );

    expect(mockConversationUpsert).toHaveBeenCalledTimes(1);
    const arg = mockConversationUpsert.mock.calls[0][0] as {
      create: { last_inbound_at: Date };
      update: { last_inbound_at: Date };
    };
    expect(arg.create.last_inbound_at).toEqual(expected);
    expect(arg.update.last_inbound_at).toEqual(expected);
  });
});
