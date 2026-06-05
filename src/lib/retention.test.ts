import { describe, it, expect, beforeEach, vi } from "vitest";

const mockWorkspaceFindMany = vi.fn();
const mockMessageFindMany = vi.fn();
const mockMessageDeleteMany = vi.fn();
const mockCommentFindMany = vi.fn();
const mockCommentDeleteMany = vi.fn();
const mockConversationDeleteMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspace: { findMany: (...a: unknown[]) => mockWorkspaceFindMany(...a) },
    message: {
      findMany: (...a: unknown[]) => mockMessageFindMany(...a),
      deleteMany: (...a: unknown[]) => mockMessageDeleteMany(...a),
    },
    commentLog: {
      findMany: (...a: unknown[]) => mockCommentFindMany(...a),
      deleteMany: (...a: unknown[]) => mockCommentDeleteMany(...a),
    },
    conversation: { deleteMany: (...a: unknown[]) => mockConversationDeleteMany(...a) },
  },
}));

import { pruneOldMessages } from "./retention";

const now = new Date("2026-06-05T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockMessageFindMany.mockResolvedValue([]);
  mockCommentFindMany.mockResolvedValue([]);
  mockMessageDeleteMany.mockResolvedValue({ count: 0 });
  mockCommentDeleteMany.mockResolvedValue({ count: 0 });
  mockConversationDeleteMany.mockResolvedValue({ count: 0 });
});

describe("pruneOldMessages — auto-retention", () => {
  it("does nothing when no workspace has a retention policy", async () => {
    mockWorkspaceFindMany.mockResolvedValueOnce([]);

    const result = await pruneOldMessages(now);

    expect(result.deletedMessages).toBe(0);
    expect(mockMessageDeleteMany).not.toHaveBeenCalled();
    expect(mockWorkspaceFindMany.mock.calls[0][0].where.message_retention_days).toEqual({ not: null });
  });

  it("deletes terminal messages older than the cutoff, never held/pending", async () => {
    mockWorkspaceFindMany.mockResolvedValueOnce([{ id: "ws-1", message_retention_days: 30 }]);
    mockMessageFindMany.mockResolvedValueOnce([{ id: "m1" }, { id: "m2" }]); // < batch size → one pass
    mockMessageDeleteMany.mockResolvedValueOnce({ count: 2 });

    const result = await pruneOldMessages(now);

    expect(result.deletedMessages).toBe(2);
    const where = mockMessageFindMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["sent", "delivered", "failed", "expired"] });
    expect(where.conversation).toEqual({ workspace_id: "ws-1" });
    const cutoff = where.created_at.lt as Date;
    expect(cutoff.getTime()).toBe(now.getTime() - 30 * 86_400_000);
  });

  it("removes conversations left empty after pruning", async () => {
    mockWorkspaceFindMany.mockResolvedValueOnce([{ id: "ws-1", message_retention_days: 7 }]);
    mockConversationDeleteMany.mockResolvedValueOnce({ count: 3 });

    const result = await pruneOldMessages(now);

    expect(result.deletedConversations).toBe(3);
    const where = mockConversationDeleteMany.mock.calls[0][0].where;
    expect(where.workspace_id).toBe("ws-1");
    expect(where.messages).toEqual({ none: {} });
  });

  it("also prunes old comment logs", async () => {
    mockWorkspaceFindMany.mockResolvedValueOnce([{ id: "ws-1", message_retention_days: 14 }]);
    mockCommentFindMany.mockResolvedValueOnce([{ id: "c1" }]);
    mockCommentDeleteMany.mockResolvedValueOnce({ count: 1 });

    const result = await pruneOldMessages(now);

    expect(result.deletedComments).toBe(1);
    expect(mockCommentFindMany.mock.calls[0][0].where.workspace_id).toBe("ws-1");
  });
});
