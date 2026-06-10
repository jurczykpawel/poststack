import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// resolveReplyContent runs the AI-rephrase path: workspace LLM budget + output clamp
//. Mock the LLM call and the rate limiter so this is a pure unit test (no network/db).
const rephrase = vi.fn(async (t: string) => t);
vi.mock("@/lib/ai/rephrase", () => ({ rephrase: (...a: unknown[]) => rephrase(...(a as [string])) }));
const rateLimit = vi.fn(async () => ({ allowed: true, remaining: 1, retryAfter: 0 }));
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...(a as [])) }));

let resolveReplyContent: typeof import("./executor").resolveReplyContent;
const WS = "ws-aud162";

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.TOKEN_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
  ({ resolveReplyContent } = await import("./executor"));
});

beforeEach(() => {
  rephrase.mockReset().mockImplementation(async (t: string) => t);
  rateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 1, retryAfter: 0 });
});

describe("AI-rephrase per-workspace budget", () => {
  it("calls the LLM (keyed per workspace) when under budget", async () => {
    rephrase.mockResolvedValueOnce("rephrased!");
    const content = await resolveReplyContent(WS, "ai_rephrase", { text: "hello" });
    expect(rateLimit).toHaveBeenCalledWith(`rl:llm:${WS}`, expect.any(Number), 86_400);
    expect(rephrase).toHaveBeenCalledTimes(1);
    expect(content?.text).toBe("rephrased!");
  });

  it("fails soft to the operator base text WITHOUT an LLM call once over budget", async () => {
    rateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfter: 60 });
    const content = await resolveReplyContent(WS, "ai_rephrase", { text: "hello" });
    expect(rephrase).not.toHaveBeenCalled();
    expect(content?.text).toBe("hello");
  });

  it("does not touch the LLM budget for a non-AI rule", async () => {
    const content = await resolveReplyContent(WS, "text", { text: "plain" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(rephrase).not.toHaveBeenCalled();
    expect(content?.text).toBe("plain");
  });
});

describe("AI-rephrase output clamp", () => {
  it("clamps an overlong + control-char LLM completion to the write-side bound", async () => {
    rephrase.mockResolvedValueOnce("A".repeat(5000) + "\u0000\u0007bad");
    const content = await resolveReplyContent(WS, "ai_rephrase", { text: "hi" });
    expect([...(content!.text as string)].length).toBeLessThanOrEqual(2000);
    expect(content!.text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it("keeps tab/newline and ordinary text intact", async () => {
    rephrase.mockResolvedValueOnce("line one\nline\ttwo");
    const content = await resolveReplyContent(WS, "ai_rephrase", { text: "hi" });
    expect(content!.text).toBe("line one\nline\ttwo");
  });
});
