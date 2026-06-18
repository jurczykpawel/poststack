import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// CONFIG1: rephrase now reads the provider-neutral AI_* keys via getConfig. This is a pure-unit test
// (no DB), so mock getConfig to read straight from process.env — keeping the per-case env control
// below while avoiding a lazy DB import. (Legacy OPENAI_* alias resolution is exercised against a real
// DB in settings/config.integration.test.ts.) Mirrors connect-token.test.ts / meta-api-contract.test.ts.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));

const originalFetch = globalThis.fetch;

let lastUrl = "";
let lastBody: { model: string; messages: Array<{ role: string; content: string }> } | null = null;

function mockFetchOk(content: string) {
  globalThis.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
    lastUrl = String(url);
    lastBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content } }] });
  }) as unknown as typeof fetch;
}

async function loadRephrase() {
  vi.resetModules();
  return (await import("./rephrase")).rephrase;
}

beforeAll(() => {
  // The env schema validates the whole environment on load; give it the required vars once.
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

describe("rephrase — AI adapter", () => {
  it("returns the base text when no API key is configured", async () => {
    delete process.env.AI_API_KEY;
    const rephrase = await loadRephrase();
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("returns the rephrased completion on success", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("  Rephrased  ");
    expect(await rephrase("Hello", {})).toBe("Rephrased");
  });

  it("falls back to base text on an API error", async () => {
    const rephrase = await loadRephrase();
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("falls back to base text when the request throws", async () => {
    const rephrase = await loadRephrase();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("falls back to base text on an empty completion", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("   ");
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("uses custom_prompt as the system message", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("Base", { customPrompt: "Speak like a pirate." });
    expect(lastBody!.messages[0]).toEqual({ role: "system", content: "Speak like a pirate." });
    expect(lastBody!.messages[1]).toEqual({ role: "user", content: "Base" });
  });

  // the configured model + endpoint are honored (a non-OpenAI OpenAI-compatible provider works).
  it("honors AI_MODEL and AI_BASE_URL overrides (any OpenAI-compatible endpoint)", async () => {
    process.env.AI_MODEL = "llama-3.3-70b-versatile";
    process.env.AI_BASE_URL = "https://api.groq.com/openai/v1";
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("Base", {});
    expect(lastBody!.model).toBe("llama-3.3-70b-versatile");
    expect(lastUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});
