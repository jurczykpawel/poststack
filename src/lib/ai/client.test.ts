import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// Mirrors rephrase.test.ts: pure-unit test (no DB), so mock getConfig to read straight from
// process.env, keeping per-case env control while avoiding a lazy DB import.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));

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
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("chatComplete — shared LLM client", () => {
  it("returns the trimmed assistant content on a 2xx response", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("  Hi there  ");
    expect(await chatComplete({ system: "sys", user: "usr" })).toBe("Hi there");
  });

  it("returns null when no API key is configured", async () => {
    delete process.env.AI_API_KEY;
    const chatComplete = await loadChatComplete();
    expect(await chatComplete({ system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null on a non-2xx response", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await chatComplete({ system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null when the request throws / times out", async () => {
    const chatComplete = await loadChatComplete();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await chatComplete({ system: "sys", user: "usr" })).toBeNull();
  });

  it("returns null on an empty completion", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("   ");
    expect(await chatComplete({ system: "sys", user: "usr" })).toBeNull();
  });

  it("sends model, max_tokens, temperature and system/user messages", async () => {
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ system: "You are X.", user: "Hello", maxTokens: 123, temperature: 0.5 });
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
    await chatComplete({ system: "sys", user: "usr" });
    expect(lastBody!.model).toBe("llama-3.3-70b-versatile");
    expect(lastUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});
