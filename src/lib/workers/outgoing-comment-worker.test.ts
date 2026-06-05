import { describe, it, expect, beforeEach, vi } from "vitest";

const mockChannelFindUnique = vi.fn();
const mockCommentUpdateMany = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findUnique: (...a: unknown[]) => mockChannelFindUnique(...a) },
    commentLog: { updateMany: (...a: unknown[]) => mockCommentUpdateMany(...a) },
  },
}));

const mockIsClaimed = vi.fn().mockResolvedValue(false);
const mockClaim = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/idempotency", () => ({
  isClaimed: (...a: unknown[]) => mockIsClaimed(...a),
  claim: (...a: unknown[]) => mockClaim(...a),
}));

vi.mock("@/lib/crypto", () => ({ decryptTokens: () => ({ access_token: "x" }) }));

const mockSendComment = vi.fn();
vi.mock("@/lib/platforms/registry", () => ({
  getProvider: () => ({ sendComment: (...a: unknown[]) => mockSendComment(...a) }),
}));

const mockNeedsReauth = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/channels/health", () => ({ markChannelNeedsReauth: (...a: unknown[]) => mockNeedsReauth(...a) }));

import { processOutgoingComment } from "./outgoing-comment-worker";
import { TokenInvalidError } from "@/lib/platforms/errors";

const helpers = { logger: { info: vi.fn() } } as never;
const payload = { channelId: "ch-1", commentId: "cm-1", text: "Reply!", sentByRuleId: "r-1", idempotencyKey: "idem-1" } as never;
const active = { id: "ch-1", platform: "facebook", token_encrypted: "enc", status: "active" };

describe("processOutgoingComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsClaimed.mockResolvedValue(false);
    mockChannelFindUnique.mockResolvedValue(active);
  });

  it("skips a duplicate send when the idempotency key is already claimed", async () => {
    mockIsClaimed.mockResolvedValueOnce(true);
    await processOutgoingComment(payload, helpers);
    expect(mockSendComment).not.toHaveBeenCalled();
  });

  it("throws when the channel is missing or disabled", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ ...active, status: "disabled" });
    await expect(processOutgoingComment(payload, helpers)).rejects.toThrow();
  });

  it("does not reply while the breaker is open (needs_reauth)", async () => {
    mockChannelFindUnique.mockResolvedValueOnce({ ...active, status: "needs_reauth" });
    await processOutgoingComment(payload, helpers);
    expect(mockSendComment).not.toHaveBeenCalled();
  });

  it("posts the reply, claims the key, and marks the comment replied", async () => {
    mockSendComment.mockResolvedValueOnce(undefined);
    await processOutgoingComment(payload, helpers);
    expect(mockSendComment).toHaveBeenCalledWith({ access_token: "x" }, "cm-1", "Reply!");
    expect(mockClaim).toHaveBeenCalledWith("idem-1");
    expect(mockCommentUpdateMany).toHaveBeenCalledWith({
      where: { platform_comment_id: "cm-1", channel_id: "ch-1" },
      data: { reply_sent: true, matched_rule_id: "r-1" },
    });
  });

  it("flags needs_reauth without retrying on an invalid token", async () => {
    mockSendComment.mockRejectedValueOnce(new TokenInvalidError("dead"));
    await processOutgoingComment(payload, helpers); // no throw
    expect(mockNeedsReauth).toHaveBeenCalledWith("ch-1", "dead");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("re-throws a transient error so the job retries", async () => {
    mockSendComment.mockRejectedValueOnce(new Error("blip"));
    await expect(processOutgoingComment(payload, helpers)).rejects.toThrow("blip");
    expect(mockNeedsReauth).not.toHaveBeenCalled();
  });
});
