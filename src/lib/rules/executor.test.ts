import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.JWT_EXPIRY = "7d";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test";
  process.env.META_APP_SECRET = "test";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

// addJob(task, payload, opts?) — dispatch by task so call shape stays
// [task, payload], identical to the former queue.add(task, payload).
const mockAddMessage = vi.fn().mockResolvedValue(undefined);
const mockAddComment = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/queue/client", () => ({
  addJob: (task: string, ...rest: unknown[]) => {
    if (task === "outgoing-message") return mockAddMessage(task, ...rest);
    if (task === "outgoing-comment") return mockAddComment(task, ...rest);
    return Promise.resolve();
  },
}));

// Cooldown + lifetime cap now live in lib/rules/limits (Postgres-atomic).
// The atomic SQL semantics are covered by limits.integration.test.ts; here we
// assert the executor calls them with the right args and honours their result.
const mockAcquireCooldown = vi.fn().mockResolvedValue(true);
const mockIncrementSendCount = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/rules/limits", () => ({
  acquireCooldown: (...args: unknown[]) => mockAcquireCooldown(...args),
  incrementSendCount: (...args: unknown[]) => mockIncrementSendCount(...args),
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

  it("acquires the cooldown with rule id, contact id, and seconds", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ cooldown_seconds: 120 })]);

    await evaluateRules(baseInput);

    expect(mockAcquireCooldown).toHaveBeenCalledWith("rule-1", "contact-1", 120);
  });

  it("skips rule when the cooldown is not acquired (still cooling down)", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ cooldown_seconds: 60 })]);
    mockAcquireCooldown.mockResolvedValueOnce(false);

    const result = await evaluateRules(baseInput);
    expect(result).toBeNull();
    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});

describe("evaluateRules — per-rule send limit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("increments the send counter with rule id, contact id, and cap", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ max_sends_per_contact: 5 })]);

    await evaluateRules(baseInput);

    expect(mockIncrementSendCount).toHaveBeenCalledWith("rule-1", "contact-1", 5);
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it("skips when the lifetime cap has been reached", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ max_sends_per_contact: 3 })]);
    mockIncrementSendCount.mockResolvedValueOnce(false);

    const result = await evaluateRules(baseInput);
    expect(result).toBeNull();
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

  it("text with no configured text sends nothing (rule still counts as fired)", async () => {
    mockFindMany.mockResolvedValueOnce([makeRule({ response_type: "text", response_config: {} })]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it("random_text with an empty messages array sends nothing", async () => {
    mockFindMany.mockResolvedValueOnce([
      makeRule({ response_type: "random_text", response_config: { messages: [] } }),
    ]);

    const result = await evaluateRules(baseInput);

    expect(result).toBe("rule-1");
    expect(mockAddMessage).not.toHaveBeenCalled();
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

describe("evaluateRules — ai_rephrase (LLM with mocked fetch)", () => {
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-openai-key";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  const aiRule = () =>
    makeRule({ response_type: "ai_rephrase", response_config: { text: "Base message", tone: "casual" } });

  it("sends the rephrased text on a successful API call", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "  Rephrased!  " } }] }),
    ) as typeof fetch;
    mockFindMany.mockResolvedValueOnce([aiRule()]);

    await evaluateRules(baseInput);

    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Rephrased!");
  });

  it("falls back to the base text when the API responds with an error", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    mockFindMany.mockResolvedValueOnce([aiRule()]);

    await evaluateRules(baseInput);

    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Base message");
  });

  it("falls back to the base text when the request throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    mockFindMany.mockResolvedValueOnce([aiRule()]);

    await evaluateRules(baseInput);

    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Base message");
  });

  it("uses custom_prompt as the system message when provided", async () => {
    let sentBody: { messages: Array<{ role: string; content: string }> } | null = null;
    globalThis.fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    mockFindMany.mockResolvedValueOnce([
      makeRule({
        response_type: "ai_rephrase",
        response_config: { text: "Base", custom_prompt: "Speak like a pirate." },
      }),
    ]);

    await evaluateRules(baseInput);

    expect(sentBody!.messages[0]).toEqual({ role: "system", content: "Speak like a pirate." });
    expect(sentBody!.messages[1]).toEqual({ role: "user", content: "Base" });
  });

  it("falls back to base text when the API returns an empty completion", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "   " } }] }),
    ) as typeof fetch;
    mockFindMany.mockResolvedValueOnce([aiRule()]);

    await evaluateRules(baseInput);

    expect(mockAddMessage.mock.calls[0][1].content.text).toBe("Base message");
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
