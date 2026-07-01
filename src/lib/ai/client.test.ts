import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// Mirrors rephrase.test.ts: pure-unit test (no DB), so mock getConfig to read straight from
// process.env, keeping per-case env control while avoiding a lazy DB import.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));
// ADLOG1: chatComplete now writes a generation log on every real attempt — mock the write boundary
// so this stays a pure-unit test (no DB) and capture calls to assert what gets logged.
const logGeneration = vi.fn(async (_entry: unknown) => {});
vi.mock("@/lib/ai/generation-log", () => ({ logGeneration: (...a: unknown[]) => logGeneration(...(a as [unknown])) }));

const originalFetch = globalThis.fetch;

let lastUrl = "";
let lastBody: {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
} | null = null;

function mockFetchOk(content: string) {
  globalThis.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
    lastUrl = String(url);
    lastBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content } }] });
  }) as unknown as typeof fetch;
}

async function loadChatComplete() {
  vi.resetModules();
  return (await import("./client")).chatComplete;
}

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/test";
});

beforeEach(() => {
  process.env.AI_API_KEY = "test-key";
  delete process.env.AI_MODEL;
  delete process.env.AI_BASE_URL;
  lastUrl = "";
  lastBody = null;
  logGeneration.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("chatComplete — shared LLM client", () => {
  it("returns the trimmed assistant content on a 2xx response", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("  Hi there  ");
    expect(await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" })).toBe("Hi there");
  });

  it("returns null when no API key is configured", async () => {
    delete process.env.AI_API_KEY;
    const chatComplete = await loadChatComplete();
    expect(await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null when the request throws / times out", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null on an empty completion", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("   ");
    expect(await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" })).toBeNull();
  });

  it("sends model, max_tokens, temperature and system/user messages", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "You are X.", user: "Hello", maxTokens: 123, temperature: 0.5 });
    expect(lastBody!.model).toBe("gpt-4o-mini");
    expect(lastBody!.max_tokens).toBe(123);
    expect(lastBody!.temperature).toBe(0.5);
    expect(lastBody!.messages).toEqual([
      { role: "system", content: "You are X." },
      { role: "user", content: "Hello" },
    ]);
  });

  it("honors AI_MODEL and AI_BASE_URL overrides", async () => {
    process.env.AI_MODEL = "llama-3.3-70b-versatile";
    process.env.AI_BASE_URL = "https://api.groq.com/openai/v1";
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "sys", user: "usr" });
    expect(lastBody!.model).toBe("llama-3.3-70b-versatile");
    expect(lastUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});

describe("chatComplete — ADLOG1 generation logging", () => {
  it("logs the exact request + response on a successful completion", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("  Hi there  ");
    await chatComplete({ workspaceId: "WS-log", kind: "rephrase", system: "sys prompt", user: "user msg" });
    expect(logGeneration).toHaveBeenCalledTimes(1);
    const entry = logGeneration.mock.calls[0][0] as { durationMs: number };
    expect(entry).toMatchObject({ workspaceId: "WS-log", kind: "rephrase", model: "gpt-4o-mini", system: "sys prompt", user: "user msg", response: "Hi there", error: null });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs response=null + the HTTP status as error on a non-2xx", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    await chatComplete({ workspaceId: "WS-log", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration.mock.calls[0][0]).toMatchObject({ response: null, error: "HTTP 500" });
  });

  it("logs response=null + the caught error message on a thrown/timed-out request", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network boom");
    }) as typeof fetch;
    await chatComplete({ workspaceId: "WS-log", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration.mock.calls[0][0]).toMatchObject({ response: null, error: "network boom" });
  });

  it("logs response=null + 'empty completion' as error when the model returns nothing usable", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("   ");
    await chatComplete({ workspaceId: "WS-log", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration.mock.calls[0][0]).toMatchObject({ response: null, error: "empty completion" });
  });

  it("does NOT log when no API key is configured — not a real attempt", async () => {
    delete process.env.AI_API_KEY;
    const chatComplete = await loadChatComplete();
    await chatComplete({ workspaceId: "WS-log", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration).not.toHaveBeenCalled();
  });

  it("forwards conversationId to the log entry when given (ADLOG2)", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-log", conversationId: "CONV-1", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration.mock.calls[0][0]).toMatchObject({ conversationId: "CONV-1" });
  });

  it("logs conversationId=undefined when the caller doesn't pass one", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-log", kind: "draft", system: "sys", user: "usr" });
    expect(logGeneration.mock.calls[0][0]).toMatchObject({ conversationId: undefined });
  });
});
