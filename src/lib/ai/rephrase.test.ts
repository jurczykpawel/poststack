import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { rephrase } from "./rephrase";

const originalFetch = globalThis.fetch;
const savedKey = process.env.OPENAI_API_KEY;
const savedModel = process.env.AI_REPHRASE_MODEL;
const savedBase = process.env.OPENAI_BASE_URL;

let lastUrl = "";
let lastBody: { model: string; messages: Array<{ role: string; content: string }> } | null = null;

function mockFetchOk(content: string) {
  globalThis.fetch = vi.fn(async (url: unknown, init: { body: string }) => {
    lastUrl = String(url);
    lastBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content } }] });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.AI_REPHRASE_MODEL;
  delete process.env.OPENAI_BASE_URL;
  lastUrl = "";
  lastBody = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries({ OPENAI_API_KEY: savedKey, AI_REPHRASE_MODEL: savedModel, OPENAI_BASE_URL: savedBase })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("rephrase — AI adapter", () => {
  it("returns the base text when no API key is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("returns the rephrased completion on success", async () => {
    mockFetchOk("  Rephrased  ");
    expect(await rephrase("Hello", {})).toBe("Rephrased");
  });

  it("falls back to base text on an API error", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("falls back to base text when the request throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as typeof fetch;
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("falls back to base text on an empty completion", async () => {
    mockFetchOk("   ");
    expect(await rephrase("Hello", {})).toBe("Hello");
  });

  it("uses custom_prompt as the system message", async () => {
    mockFetchOk("ok");
    await rephrase("Base", { customPrompt: "Speak like a pirate." });
    expect(lastBody!.messages[0]).toEqual({ role: "system", content: "Speak like a pirate." });
    expect(lastBody!.messages[1]).toEqual({ role: "user", content: "Base" });
  });

  it("honors AI_REPHRASE_MODEL and OPENAI_BASE_URL overrides", async () => {
    process.env.AI_REPHRASE_MODEL = "gpt-4o";
    process.env.OPENAI_BASE_URL = "https://proxy.test/v1";
    mockFetchOk("ok");
    await rephrase("Base", {});
    expect(lastBody!.model).toBe("gpt-4o");
    expect(lastUrl).toBe("https://proxy.test/v1/chat/completions");
  });
});
