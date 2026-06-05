import { describe, it, expect, beforeEach, vi } from "vitest";

const mockChannelFindFirst = vi.fn();
const mockCommentCreate = vi.fn();
const mockContactChannelFindFirst = vi.fn();
const mockConversationFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: { findFirst: (...a: unknown[]) => mockChannelFindFirst(...a) },
    commentLog: { create: (...a: unknown[]) => mockCommentCreate(...a) },
    contactChannel: { findFirst: (...a: unknown[]) => mockContactChannelFindFirst(...a) },
    conversation: { findFirst: (...a: unknown[]) => mockConversationFindFirst(...a) },
  },
}));

vi.mock("@/generated/prisma/client", () => {
  class FakePrismaError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  return { Prisma: { PrismaClientKnownRequestError: FakePrismaError } };
});

const mockEvaluateRules = vi.fn().mockResolvedValue("rule-1");
vi.mock("@/lib/rules/executor", () => ({ evaluateRules: (...a: unknown[]) => mockEvaluateRules(...a) }));

import { processIncomingComment } from "./incoming-comment-worker";
import { Prisma } from "@/generated/prisma/client";

const helpers = { logger: { info: vi.fn() } } as never;
const base = { pageId: "PG", commentId: "cm-1", postId: "post-1", senderId: "S1", senderName: "Joe", text: "info please" } as never;

describe("processIncomingComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelFindFirst.mockResolvedValue({ id: "ch-1", workspace_id: "ws-1" });
    mockCommentCreate.mockResolvedValue({});
    mockContactChannelFindFirst.mockResolvedValue({ contact_id: "co-1", platform_sender_id: "S1" });
    mockConversationFindFirst.mockResolvedValue({ id: "cv-1", is_automation_paused: false });
  });

  it("skips an empty comment", async () => {
    await processIncomingComment(
      { pageId: "PG", commentId: "cm-2", postId: "post-1", senderId: "S1", senderName: "Joe", text: undefined } as never,
      helpers,
    );
    expect(mockChannelFindFirst).not.toHaveBeenCalled();
  });

  it("skips when no active channel matches the page", async () => {
    mockChannelFindFirst.mockResolvedValueOnce(null);
    await processIncomingComment(base, helpers);
    expect(mockCommentCreate).not.toHaveBeenCalled();
  });

  it("logs the comment and evaluates comment rules", async () => {
    await processIncomingComment(base, helpers);
    expect(mockCommentCreate).toHaveBeenCalled();
    expect(mockEvaluateRules).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "comment", commentId: "cm-1", conversationId: "cv-1" }),
    );
  });

  it("skips a duplicate comment (unique constraint) without evaluating rules", async () => {
    const ErrCtor = Prisma.PrismaClientKnownRequestError as unknown as new (code: string) => Error;
    mockCommentCreate.mockRejectedValueOnce(new ErrCtor("P2002"));
    await processIncomingComment(base, helpers);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("does not evaluate rules when automation is paused", async () => {
    mockConversationFindFirst.mockResolvedValueOnce({ id: "cv-1", is_automation_paused: true });
    await processIncomingComment(base, helpers);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });

  it("does not evaluate rules when the commenter has no contact yet", async () => {
    mockContactChannelFindFirst.mockResolvedValueOnce(null);
    await processIncomingComment(base, helpers);
    expect(mockEvaluateRules).not.toHaveBeenCalled();
  });
});
