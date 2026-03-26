import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.REDIS_URL = "redis://localhost:6379";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test";
  process.env.META_APP_SECRET = "test";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

// Mock queues
const mockAddMessage = vi.fn().mockResolvedValue({});
const mockAddComment = vi.fn().mockResolvedValue({});
vi.mock("@/lib/queue/client", () => ({
  outgoingMessagesQueue: { add: (...args: unknown[]) => mockAddMessage(...args) },
  outgoingCommentsQueue: { add: (...args: unknown[]) => mockAddComment(...args) },
}));

// Mock Redis
const mockRedisSet = vi.fn().mockResolvedValue("OK");
vi.mock("@/lib/redis", () => ({
  redis: { set: (...args: unknown[]) => mockRedisSet(...args) },
}));

// Mock Prisma
const mockFindMany = vi.fn().mockResolvedValue([]);
const mockMessageCount = vi.fn().mockResolvedValue(0);
const mockPendingCreate = vi.fn().mockResolvedValue({});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    autoReplyRule: { findMany: (...args: unknown[]) => mockFindMany(...args) },
    message: { count: (...args: unknown[]) => mockMessageCount(...args) },
    pendingApproval: { create: (...args: unknown[]) => mockPendingCreate(...args) },
  },
}));

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    is_active: true,
    priority: 0,
    cooldown_seconds: 0,
    max_sends_per_contact: null,
    requires_approval: false,
    trigger_type: "keyword",
    trigger_config: { keywords: [{ value: "hello", match_type: "exact" }] },
    response_type: "text",
    response_config: { text: "Hi there!" },
    actions: [],
    ...overrides,
  };
}

const baseInput = {
  workspaceId: "ws-1",
  channelId: "ch-1",
  conversationId: "conv-1",
  contactId: "contact-1",
  recipientPlatformId: "psid-1",
  text: "hello",
  eventType: "message" as const,
};

describe("evaluateRules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires DM when rule matches with reply_mode=dm (default)", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule()]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("fires public comment reply when reply_mode=comment", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
        response_config: { text: "DM text", comment_reply_text: "Thanks!", reply_mode: "comment" },
      }),
    ]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules({
      ...baseInput,
      text: "need info",
      eventType: "comment",
      commentId: "comment-123",
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddComment.mock.calls[0][1].commentId).toBe("comment-123");
    expect(mockAddComment.mock.calls[0][1].text).toBe("Thanks!");
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("fires both DM + comment reply when reply_mode=both", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "deal", match_type: "exact" }] },
        response_config: { text: "Check your DM!", comment_reply_text: "Sent you a DM!", reply_mode: "both" },
      }),
    ]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules({
      ...baseInput,
      text: "deal",
      eventType: "comment",
      commentId: "comment-456",
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("skips rule when max_sends_per_contact reached", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ max_sends_per_contact: 3 }),
    ]);
    mockMessageCount.mockResolvedValueOnce(3); // already sent 3 times

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("fires rule when sends below limit", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ max_sends_per_contact: 5 }),
    ]);
    mockMessageCount.mockResolvedValueOnce(2); // only 2 of 5

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("creates PendingApproval when requires_approval=true", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ requires_approval: true }),
    ]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockPendingCreate).toHaveBeenCalledTimes(1);
    expect(mockPendingCreate.mock.calls[0][0].data.workspace_id).toBe("ws-1");
    expect(mockPendingCreate.mock.calls[0][0].data.status).toBeUndefined(); // uses @default("pending")
    expect(mockAddMessage).not.toHaveBeenCalled(); // NOT auto-sent
  });

  it("returns null when no rules match", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ trigger_config: { keywords: [{ value: "goodbye", match_type: "exact" }] } }),
    ]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("respects cooldown via Redis SETNX", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ cooldown_seconds: 60 }),
    ]);
    mockRedisSet.mockResolvedValueOnce(null); // lock already taken

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("fires random_text response type", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        response_type: "random_text",
        response_config: { messages: ["A", "B", "C"] },
      }),
    ]);

    const { evaluateRules } = await import("./executor");
    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    const sentText = mockAddMessage.mock.calls[0][1].content.text;
    expect(["A", "B", "C"]).toContain(sentText);
  });
});
