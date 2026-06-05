import { describe, it, expect, beforeEach, vi } from "vitest";

const mockMessageCreate = vi.fn().mockResolvedValue({});
const mockMessageUpdate = vi.fn().mockResolvedValue({});
const mockChannelFindUnique = vi.fn();
const mockConversationUpdate = vi.fn().mockResolvedValue({});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      create: (...a: unknown[]) => mockMessageCreate(...a),
      update: (...a: unknown[]) => mockMessageUpdate(...a),
    },
    channel: { findUnique: (...a: unknown[]) => mockChannelFindUnique(...a) },
    conversation: { update: (...a: unknown[]) => mockConversationUpdate(...a) },
  },
}));

const mockIsClaimed = vi.fn().mockResolvedValue(false);
const mockClaim = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/idempotency", () => ({
  isClaimed: (...a: unknown[]) => mockIsClaimed(...a),
  claim: (...a: unknown[]) => mockClaim(...a),
}));

vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }), encryptTokens: () => "enc" }));

const mockSendMessage = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({
    requiresTokenRefresh: () => false,
    refreshBufferSeconds: () => 0,
    sendMessage: (...a: unknown[]) => mockSendMessage(...a),
  }),
}));

const mockNeedsReauth = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/health", () => ({
  markChannelNeedsReauth: (...a: unknown[]) => mockNeedsReauth(...a),
}));

import { processOutgoingMessage } from "./outgoing-message-worker";
import type { OutgoingMessageJob } from "@/lib/queue/types";
import { TokenInvalidError } from "@/lib/platforms/errors";

const helpers = { logger: { info: vi.fn() } } as never;
const basePayload: OutgoingMessageJob = {
  channelId: "ch-1",
  conversationId: "cv-1",
  contactId: "co-1",
  recipientPlatformId: "R",
  content: { text: "hi" },
  sentByRuleId: "rule-1",
};

const activeChannel = { id: "ch-1", platform: "instagram", token_encrypted: "enc", status: "active" };

describe("processOutgoingMessage — REL5 park + drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsClaimed.mockResolvedValue(false);
  });

  it("parks the message as held (not failed) when the breaker is open (needs_reauth)", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ ...activeChannel, status: "needs_reauth" });

    await processOutgoingMessage(basePayload, helpers);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate.mock.calls[0][0].data.status).toBe("held");
  });

  it("parks as held (not failed) and opens the breaker when the token is invalid on send", async () => {
    mockChannelFindUnique.mockResolvedValueOnce(activeChannel);
    mockSendMessage.mockRejectedValueOnce(new TokenInvalidError("dead"));

    await processOutgoingMessage(basePayload, helpers); // must not throw

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate.mock.calls[0][0].data.status).toBe("held");
    expect(mockNeedsReauth).toHaveBeenCalledWith("ch-1", "dead");
  });

  it("on drain (heldMessageId) success: updates the held row to sent, creates no new row", async () => {
    mockChannelFindUnique.mockResolvedValueOnce(activeChannel);
    mockSendMessage.mockResolvedValueOnce({ platformMessageId: "PMID" });

    await processOutgoingMessage(
      { ...basePayload, heldMessageId: "msg-1", idempotencyKey: "held:msg-1" },
      helpers,
    );

    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockMessageUpdate).toHaveBeenCalledTimes(1);
    expect(mockMessageUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "msg-1" },
      data: { status: "sent", platform_message_id: "PMID" },
    });
    expect(mockClaim).toHaveBeenCalledWith("held:msg-1");
  });

  it("on drain (heldMessageId) while breaker reopened: leaves the row held, no new row, no throw", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ ...activeChannel, status: "needs_reauth" });

    await processOutgoingMessage({ ...basePayload, heldMessageId: "msg-1" }, helpers);

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockMessageUpdate).not.toHaveBeenCalled();
  });

  it("re-throws transient send errors (retry) and records a failed row", async () => {
    mockChannelFindUnique.mockResolvedValueOnce(activeChannel);
    mockSendMessage.mockRejectedValueOnce(new Error("network blip"));

    await expect(processOutgoingMessage(basePayload, helpers)).rejects.toThrow("network blip");
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockMessageCreate.mock.calls[0][0].data.status).toBe("failed");
    expect(mockNeedsReauth).not.toHaveBeenCalled();
  });
});
