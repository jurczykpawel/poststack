import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { resolveRephrasePrompt, defaultRephrasePrompt, DEFAULT_REPHRASE_PROMPT, DEFAULT_REPHRASE_TONE } from "./rephrase";

// CONFIG1: rephrase now reads the provider-neutral AI_* keys via getConfig. This is a pure-unit test
// (no DB), so mock getConfig to read straight from process.env — keeping the per-case env control
// below while avoiding a lazy DB import. (Legacy OPENAI_* alias resolution is exercised against a real
// DB in settings/config.integration.test.ts.) Mirrors connect-token.test.ts / meta-api-contract.test.ts.
vi.mock("@/lib/settings/config", () => ({
  getConfig: async (key: string) => process.env[key] ?? "",
}));
// ADLOG1: chatComplete (called under the hood) now writes a generation log — mock the write
// boundary so this stays a pure-unit test (no DB).
vi.mock("@/lib/ai/generation-log", () => ({ logGeneration: async () => {} }));

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
    expect(await rephrase("WS-1", "Hello", {})).toBe("Hello");
  });

  it("returns the rephrased completion on success", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("  Rephrased  ");
    expect(await rephrase("WS-1", "Hello", {})).toBe("Rephrased");
  });

  it("falls back to base text on an API error", async () => {
    const rephrase = await loadRephrase();
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await rephrase("WS-1", "Hello", {})).toBe("Hello");
  });

  it("falls back to base text when the request throws", async () => {
    const rephrase = await loadRephrase();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await rephrase("WS-1", "Hello", {})).toBe("Hello");
  });

  it("falls back to base text on an empty completion", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("   ");
    expect(await rephrase("WS-1", "Hello", {})).toBe("Hello");
  });

  it("uses custom_prompt as the system message", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("WS-1", "Base", { customPrompt: "Speak like a pirate." });
    expect(lastBody!.messages[0]).toEqual({ role: "system", content: "Speak like a pirate." });
    expect(lastBody!.messages[1]).toEqual({ role: "user", content: "Base" });
  });

  it("uses the workspace default prompt as the system message when no custom_prompt is set", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("WS-1", "Base", { workspacePrompt: "Rephrase concisely in Polish." });
    expect(lastBody!.messages[0]).toEqual({ role: "system", content: "Rephrase concisely in Polish." });
  });

  it("a rule custom_prompt wins over the workspace default prompt", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("WS-1", "Base", { customPrompt: "Speak like a pirate.", workspacePrompt: "Concise Polish." });
    expect(lastBody!.messages[0].content).toBe("Speak like a pirate.");
  });

  it("falls back to the built-in default prompt when neither custom nor workspace is set", async () => {
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("WS-1", "Base", {});
    expect(lastBody!.messages[0].content).toBe(DEFAULT_REPHRASE_PROMPT);
  });

  // the configured model + endpoint are honored (a non-OpenAI OpenAI-compatible provider works).
  it("honors AI_MODEL and AI_BASE_URL overrides (any OpenAI-compatible endpoint)", async () => {
    process.env.AI_MODEL = "llama-3.3-70b-versatile";
    process.env.AI_BASE_URL = "https://api.groq.com/openai/v1";
    const rephrase = await loadRephrase();
    mockFetchOk("ok");
    await rephrase("WS-1", "Base", {});
    expect(lastBody!.model).toBe("llama-3.3-70b-versatile");
    expect(lastUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});

describe("resolveRephrasePrompt (AIPROMPT option A: rule → workspace → built-in default)", () => {
  it("uses the per-rule prompt when set", () => {
    expect(resolveRephrasePrompt({ rulePrompt: "R", workspacePrompt: "W" })).toBe("R");
  });

  it("uses the workspace default when there is no rule prompt", () => {
    expect(resolveRephrasePrompt({ rulePrompt: "  ", workspacePrompt: "W" })).toBe("W");
  });

  it("uses the built-in default (with tone) when neither is set", () => {
    expect(resolveRephrasePrompt({ tone: "blunt" })).toBe(defaultRephrasePrompt("blunt"));
    expect(resolveRephrasePrompt({})).toBe(DEFAULT_REPHRASE_PROMPT);
  });

  it("treats blank/whitespace values as unset at every level", () => {
    expect(resolveRephrasePrompt({ rulePrompt: "  ", workspacePrompt: "\n\t" })).toBe(DEFAULT_REPHRASE_PROMPT);
  });

  it("DEFAULT_REPHRASE_PROMPT is the built-in prompt with the default tone", () => {
    expect(DEFAULT_REPHRASE_PROMPT).toContain(`Tone: ${DEFAULT_REPHRASE_TONE}`);
  });
});
