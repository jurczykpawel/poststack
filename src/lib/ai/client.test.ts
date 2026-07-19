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
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  messages: Array<{ role: string; content: string }>;
} | null = null;

function mockFetchOk(content: string) {
  globalThis.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
    lastUrl = String(url);
    lastBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content } }] });
  }) as unknown as typeof fetch;
}

// Routed fetch mock for fallback-chain tests: every request is recorded and the response is chosen by
// the request's model, so a chain of providers (each with a distinct model) can be driven case by case.
type Outcome = { status: number } | { content: string } | { throw: true } | { empty: true };
let routes: Record<string, Outcome> = {};
let calls: Array<{ url: string; model: string; auth: string; hasMaxCompletion: boolean; hasTemp: boolean }> = [];
function mockRouted() {
  calls = [];
  globalThis.fetch = vi.fn(async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    calls.push({
      url: String(url),
      model: body.model,
      auth: init.headers.Authorization,
      hasMaxCompletion: "max_completion_tokens" in body,
      hasTemp: "temperature" in body,
    });
    const o = routes[body.model] ?? { content: `ok:${body.model}` };
    if ("throw" in o) throw new Error("network down");
    if ("empty" in o) return Response.json({ choices: [{ message: { content: "   " } }] });
    if ("status" in o) return new Response("err", { status: o.status });
    return Response.json({ choices: [{ message: { content: o.content } }] });
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
  delete process.env.AI_FALLBACKS;
  lastUrl = "";
  lastBody = null;
  routes = {};
  calls = [];
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

  it("uses max_completion_tokens and omits temperature for GPT-5 / o-series reasoning models", async () => {
    process.env.AI_MODEL = "gpt-5.6-terra";
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "s", user: "u", maxTokens: 200, temperature: 0.7 });
    expect(lastBody!.model).toBe("gpt-5.6-terra");
    expect(lastBody!.max_completion_tokens).toBe(200);
    expect(lastBody!.max_tokens).toBeUndefined(); // GPT-5 rejects max_tokens
    expect(lastBody!.temperature).toBeUndefined(); // GPT-5 only accepts the default (1) → omit it
  });

  it("keeps classic max_tokens + temperature for non-reasoning models (gpt-4o, Groq, …)", async () => {
    process.env.AI_MODEL = "gpt-4o";
    const chatComplete = await loadChatComplete();
    mockFetchOk("ok");
    await chatComplete({ workspaceId: "WS-1", kind: "draft", system: "s", user: "u", maxTokens: 200, temperature: 0.7 });
    expect(lastBody!.max_tokens).toBe(200);
    expect(lastBody!.temperature).toBe(0.7);
    expect(lastBody!.max_completion_tokens).toBeUndefined();
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

describe("isReasoningModel — model-family detection", () => {
  it("matches GPT-5 and o-series (incl. provider-prefixed), not gpt-4o or other providers", async () => {
    const { isReasoningModel } = await import("./client");
    for (const m of ["gpt-5", "gpt-5.6-terra", "gpt-5.4-nano", "o1", "o3-mini", "openai/gpt-5.6-terra"]) {
      expect(isReasoningModel(m)).toBe(true);
    }
    for (const m of ["gpt-4o", "gpt-4o-mini", "llama-3.3-70b-versatile", "anthropic/claude-3.5-haiku"]) {
      expect(isReasoningModel(m)).toBe(false);
    }
  });
});

describe("parseFallbacks — AI_FALLBACKS parsing", () => {
  async function parse(raw: string) {
    return (await import("./client")).parseFallbacks(raw);
  }
  it("returns [] for empty / whitespace / malformed JSON / non-array", async () => {
    expect(await parse("")).toEqual([]);
    expect(await parse("   ")).toEqual([]);
    expect(await parse("{ not json")).toEqual([]);
    expect(await parse('{"apiKey":"k","model":"m"}')).toEqual([]); // object, not array
  });
  it("parses entries and defaults baseUrl to OpenAI when omitted", async () => {
    const out = await parse('[{"apiKey":"k1","model":"m1","baseUrl":"https://x/v1"},{"apiKey":"k2","model":"m2"}]');
    expect(out).toEqual([
      { apiKey: "k1", model: "m1", baseUrl: "https://x/v1" },
      { apiKey: "k2", model: "m2", baseUrl: "https://api.openai.com/v1" },
    ]);
  });
  it("skips entries missing apiKey or model, and trims", async () => {
    const out = await parse('[{"model":"no-key"},{"apiKey":"no-model"},{"apiKey":" k ","model":" m "}]');
    expect(out).toEqual([{ apiKey: "k", model: "m", baseUrl: "https://api.openai.com/v1" }]);
  });
});

describe("buildProviderChain — primary + fallbacks", () => {
  async function chain() {
    return (await import("./client")).buildProviderChain();
  }
  it("is just the primary when no fallbacks are set (defaults applied)", async () => {
    process.env.AI_API_KEY = "prim";
    expect(await chain()).toEqual([{ apiKey: "prim", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }]);
  });
  it("orders the primary first, then each fallback", async () => {
    process.env.AI_API_KEY = "prim";
    process.env.AI_MODEL = "primary-model";
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","baseUrl":"https://fb/v1","model":"fb1"}]';
    expect(await chain()).toEqual([
      { apiKey: "prim", baseUrl: "https://api.openai.com/v1", model: "primary-model" },
      { apiKey: "k2", baseUrl: "https://fb/v1", model: "fb1" },
    ]);
  });
  it("is fallback-only when no primary key is set", async () => {
    delete process.env.AI_API_KEY;
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","model":"fb1"}]';
    expect(await chain()).toEqual([{ apiKey: "k2", model: "fb1", baseUrl: "https://api.openai.com/v1" }]);
  });
  it("is empty when neither a primary key nor fallbacks are set", async () => {
    delete process.env.AI_API_KEY;
    expect(await chain()).toEqual([]);
  });
});

describe("isAiConfigured — chain-aware", () => {
  it("is true with a fallback-only setup (no primary key)", async () => {
    delete process.env.AI_API_KEY;
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","model":"fb1"}]';
    expect(await (await import("./client")).isAiConfigured()).toBe(true);
  });
  it("is false with no primary key and no fallbacks", async () => {
    delete process.env.AI_API_KEY;
    expect(await (await import("./client")).isAiConfigured()).toBe(false);
  });
});

describe("chatComplete — provider fallback chain", () => {
  const primaryFirst = () => {
    process.env.AI_MODEL = "primary";
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","baseUrl":"https://fb1/v1","model":"fb1"},{"apiKey":"k3","baseUrl":"https://fb2/v1","model":"fb2"}]';
  };

  for (const [name, primaryOutcome] of [
    ["an HTTP 5xx error", { status: 500 } as Outcome],
    ["a 401 (any status triggers fallback)", { status: 401 } as Outcome],
    ["a thrown / timed-out request", { throw: true } as Outcome],
    ["an empty completion", { empty: true } as Outcome],
  ] as const) {
    it(`falls through to the next provider on ${name}`, async () => {
      primaryFirst();
      routes = { primary: primaryOutcome, fb1: { content: "from-fb1" } };
      const chatComplete = await loadChatComplete();
      mockRouted();
      const out = await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u", maxTokens: 100, temperature: 0.7 });
      expect(out).toBe("from-fb1");
      expect(calls.map((c) => c.model)).toEqual(["primary", "fb1"]); // order preserved, stops at first success
      expect(calls[1]!.url).toBe("https://fb1/v1/chat/completions");
      expect(calls[1]!.auth).toBe("Bearer k2");
      expect(logGeneration).toHaveBeenCalledTimes(2); // both attempts logged
      expect(logGeneration.mock.calls[0]![0]).toMatchObject({ model: "primary", response: null });
      expect(logGeneration.mock.calls[1]![0]).toMatchObject({ model: "fb1", response: "from-fb1", error: null });
    });
  }

  it("stops at the first healthy provider — later providers are never called", async () => {
    primaryFirst();
    routes = { primary: { content: "primary-ok" } };
    const chatComplete = await loadChatComplete();
    mockRouted();
    expect(await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u" })).toBe("primary-ok");
    expect(calls.map((c) => c.model)).toEqual(["primary"]);
    expect(logGeneration).toHaveBeenCalledTimes(1);
  });

  it("returns null and logs EVERY attempt when all providers fail", async () => {
    primaryFirst();
    routes = { primary: { status: 500 }, fb1: { status: 503 }, fb2: { throw: true } };
    const chatComplete = await loadChatComplete();
    mockRouted();
    expect(await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u" })).toBeNull();
    expect(calls.map((c) => c.model)).toEqual(["primary", "fb1", "fb2"]);
    expect(logGeneration).toHaveBeenCalledTimes(3);
    expect(logGeneration.mock.calls.map((c) => (c[0] as { error: string }).error)).toEqual(["HTTP 500", "HTTP 503", "network down"]);
  });

  it("applies each provider's own model params — reasoning params for a GPT-5 fallback", async () => {
    process.env.AI_MODEL = "gpt-4o"; // primary: classic params
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","model":"gpt-5.6-luna"}]'; // fallback: reasoning params
    routes = { "gpt-4o": { status: 500 }, "gpt-5.6-luna": { content: "g5-ok" } };
    const chatComplete = await loadChatComplete();
    mockRouted();
    expect(await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u" })).toBe("g5-ok");
    expect(calls[0]).toMatchObject({ model: "gpt-4o", hasMaxCompletion: false, hasTemp: true });
    expect(calls[1]).toMatchObject({ model: "gpt-5.6-luna", hasMaxCompletion: true, hasTemp: false });
  });

  it("runs a fallback-only setup (no primary key configured)", async () => {
    delete process.env.AI_API_KEY;
    process.env.AI_FALLBACKS = '[{"apiKey":"k2","model":"fb1"}]';
    routes = { fb1: { content: "fb-only" } };
    const chatComplete = await loadChatComplete();
    mockRouted();
    expect(await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u" })).toBe("fb-only");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("ignores a malformed AI_FALLBACKS and still runs the primary", async () => {
    process.env.AI_MODEL = "primary";
    process.env.AI_FALLBACKS = "{ not valid json";
    routes = { primary: { content: "primary-ok" } };
    const chatComplete = await loadChatComplete();
    mockRouted();
    expect(await chatComplete({ workspaceId: "WS", kind: "draft", system: "s", user: "u" })).toBe("primary-ok");
    expect(calls.map((c) => c.model)).toEqual(["primary"]);
  });
});
