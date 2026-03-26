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

const mockAddMessage = vi.fn().mockResolvedValue({});
const mockAddComment = vi.fn().mockResolvedValue({});
vi.mock("@/lib/queue/client", () => ({
  outgoingMessagesQueue: { add: (...args: unknown[]) => mockAddMessage(...args) },
  outgoingCommentsQueue: { add: (...args: unknown[]) => mockAddComment(...args) },
}));

const mockRedisSet = vi.fn().mockResolvedValue("OK");
const mockRedisIncr = vi.fn().mockResolvedValue(1);
const mockRedisDecr = vi.fn().mockResolvedValue(0);
vi.mock("@/lib/redis", () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    incr: (...args: unknown[]) => mockRedisIncr(...args),
    decr: (...args: unknown[]) => mockRedisDecr(...args),
  },
}));

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

// Import once -- vitest caches modules, dynamic import per test is cargo cult
import { evaluateRules } from "./executor";

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

describe("evaluateRules — DM fire", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends DM with correct payload when keyword matches", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule()]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = mockAddMessage.mock.calls[0];
    expect(jobName).toBe("outgoing-message");
    expect(jobData.channelId).toBe("ch-1");
    expect(jobData.conversationId).toBe("conv-1");
    expect(jobData.recipientPlatformId).toBe("psid-1");
    expect(jobData.content.text).toBe("Hi there!");
    expect(jobData.sentByRuleId).toBe("rule-1");
    expect(jobData.idempotencyKey).toBeDefined();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("returns null and sends nothing when no rule matches", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ trigger_config: { keywords: [{ value: "goodbye", match_type: "exact" }] } }),
    ]);

    const result = await evaluateRules(baseInput);
    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — comment reply modes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends public comment reply with correct commentId when reply_mode=comment", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "info", match_type: "contains" }] },
        response_config: { text: "DM text", comment_reply_text: "Thanks!", reply_mode: "comment" },
      }),
    ]);

    const result = await evaluateRules({
      ...baseInput, text: "need info", eventType: "comment", commentId: "comment-123",
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddComment.mock.calls[0][1].commentId).toBe("comment-123");
    expect(mockAddComment.mock.calls[0][1].text).toBe("Thanks!");
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("uses dmText as fallback when comment_reply_text not set", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "hi", match_type: "exact" }] },
        response_config: { text: "Hello from DM!", reply_mode: "comment" },
      }),
    ]);

    const result = await evaluateRules({
      ...baseInput, text: "hi", eventType: "comment", commentId: "c-1",
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment.mock.calls[0][1].text).toBe("Hello from DM!");
  });

  it("sends both DM + comment when reply_mode=both", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "deal", match_type: "exact" }] },
        response_config: { text: "Check DM!", comment_reply_text: "Sent you a DM!", reply_mode: "both" },
      }),
    ]);

    const result = await evaluateRules({
      ...baseInput, text: "deal", eventType: "comment", commentId: "c-2",
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddComment.mock.calls[0][1].text).toBe("Sent you a DM!");
    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Check DM!");
  });

  it("falls back to DM when reply_mode=comment but commentId is missing", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "test", match_type: "exact" }] },
        response_config: { text: "Fallback DM", reply_mode: "comment" },
      }),
    ]);

    const result = await evaluateRules({
      ...baseInput, text: "test", eventType: "comment", // no commentId
    });

    expect(result).toBe("rule-1");
    expect(mockAddComment).not.toHaveBeenCalled();
    // Fallback: sends DM instead of silently doing nothing
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Fallback DM");
  });
});

describe("evaluateRules — cooldown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls redis.set with correct key, TTL, and NX flag", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ cooldown_seconds: 120 })]);

    await evaluateRules(baseInput);

    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const [key, value, ex, ttl, nx] = mockRedisSet.mock.calls[0];
    expect(key).toBe("cooldown:rule-1:contact-1");
    expect(value).toBe("1");
    expect(ex).toBe("EX");
    expect(ttl).toBe(120);
    expect(nx).toBe("NX");
  });

  it("skips rule when redis.set returns null (lock taken)", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ cooldown_seconds: 60 })]);
    mockRedisSet.mockResolvedValueOnce(null);

    const result = await evaluateRules(baseInput);
    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — per-rule send limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses atomic Redis INCR with correct key format", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ max_sends_per_contact: 5 })]);
    mockRedisIncr.mockResolvedValueOnce(1); // first send

    await evaluateRules(baseInput);

    expect(mockRedisIncr).toHaveBeenCalledWith("sends:rule-1:contact-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("fires when count is at limit (INCR returns limit value)", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ max_sends_per_contact: 5 })]);
    mockRedisIncr.mockResolvedValueOnce(5); // exactly at limit

    const result = await evaluateRules(baseInput);
    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("skips and decrements when count exceeds limit", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ max_sends_per_contact: 3 })]);
    mockRedisIncr.mockResolvedValueOnce(4); // over limit

    const result = await evaluateRules(baseInput);
    expect(result).toBeNull();
    expect(mockRedisDecr).toHaveBeenCalledWith("sends:rule-1:contact-1");
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — manual approval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates PendingApproval with correct data and does NOT send", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ requires_approval: true })]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockPendingCreate).toHaveBeenCalledTimes(1);
    const data = mockPendingCreate.mock.calls[0][0].data;
    expect(data.workspace_id).toBe("ws-1");
    expect(data.rule_id).toBe("rule-1");
    expect(data.conversation_id).toBe("conv-1");
    expect(data.contact_id).toBe("contact-1");
    expect(data.channel_id).toBe("ch-1");
    expect(data.recipient_platform_id).toBe("psid-1");
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — response types", () => {
  beforeEach(() => vi.clearAllMocks());

  it("random_text picks from messages array", async () => {
    const spy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        response_type: "random_text",
        response_config: { messages: ["A", "B", "C"] },
      }),
    ]);

    await evaluateRules(baseInput);

    // Math.floor(0.5 * 3) = 1 → "B"
    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("B");
    spy.mockRestore();
  });

  it("response_type=none sends nothing", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ response_type: "none", response_config: {} }),
    ]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("ai_rephrase falls back to base text when no OPENAI_API_KEY", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      mockFindMany.mockResolvedValueOnce([
        makeRule({
          response_type: "ai_rephrase",
          response_config: { text: "Base message", tone: "casual" },
        }),
      ]);

      await evaluateRules(baseInput);

      expect(mockAddMessage).toHaveBeenCalledTimes(1);
      expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Base message");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("evaluateRules — priority ordering", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires only the first matching rule (highest priority)", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ id: "high-prio", priority: 10, response_config: { text: "High!" } }),
      makeRule({ id: "low-prio", priority: 0, response_config: { text: "Low!" } }),
    ]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("high-prio");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("High!");
  });

  it("falls through to second rule when first does not match", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ id: "no-match", trigger_config: { keywords: [{ value: "bye", match_type: "exact" }] } }),
      makeRule({ id: "fallback", trigger_type: "default", trigger_config: {} }),
    ]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("fallback");
  });
});

describe("evaluateRules — default reply_mode=dm on comment_keyword", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends DM (not comment reply) when reply_mode not set", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        trigger_type: "comment_keyword",
        trigger_config: { keywords: [{ value: "link", match_type: "contains" }] },
        response_config: { text: "Here is the link!" },
        // no reply_mode -> defaults to "dm"
      }),
    ]);

    const result = await evaluateRules({
      ...baseInput, text: "send me the link", eventType: "comment", commentId: "c-99",
    });

    expect(result).toBe("rule-1");
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Here is the link!");
    expect(mockAddComment).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — approval proposed_content", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores response_type and response_config in proposed_content", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        requires_approval: true,
        response_type: "random_text",
        response_config: { messages: ["A", "B"] },
      }),
    ]);

    await evaluateRules(baseInput);

    const content = mockPendingCreate.mock.calls[0][0].data.proposed_content;
    expect(content).toBeDefined();
    // JSON.parse(JSON.stringify(...)) roundtrip
    expect(content.response_type).toBe("random_text");
    expect(content.response_config.messages).toEqual(["A", "B"]);
  });
});

describe("evaluateRules — findMany query shape", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries with correct workspace, channel OR null, is_active, and orderBy", async () => {
    mockFindMany.mockResolvedValueOnce([]);

    await evaluateRules(baseInput);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    const query = mockFindMany.mock.calls[0][0];
    expect(query.where.workspace_id).toBe("ws-1");
    expect(query.where.is_active).toBe(true);
    expect(query.where.OR).toEqual([
      { channel_id: "ch-1" },
      { channel_id: null },
    ]);
    expect(query.orderBy).toEqual([
      { priority: "desc" },
      { created_at: "asc" },
    ]);
  });
});
