import { describe, it, expect } from "vitest";
import anthropicModels from "./__fixtures__/anthropic-models.json";
import anthropicMessage from "./__fixtures__/anthropic-message.json";
import anthropicTruncated from "./__fixtures__/anthropic-message-truncated.json";
import openaiModels from "./__fixtures__/openai-models.json";
import openaiChat from "./__fixtures__/openai-chat.json";
import openrouterModels from "./__fixtures__/openrouter-models.json";
import groqModels from "./__fixtures__/groq-models.json";
import { chatRequest, parseChatText, chatFinishedByLength, modelsRequest, parseModels, isChatModel, providerFromBaseUrl, resolveBaseUrl, modelIdError, baseUrlError, hostOf, PROVIDERS } from "./providers";

// Fixtures under __fixtures__ are responses recorded from the real APIs on 2026-11-03 (Anthropic, OpenAI
// models, OpenRouter), except openai-chat.json and groq-models.json, which follow the vendor docs.
const msgs = { system: "Be brief", user: "Hi", maxTokens: 300, temperature: 0.8 };

describe("catalog", () => {
  it("has the five providers with their base URLs", () => {
    expect(PROVIDERS.map((p) => [p.id, p.baseUrl])).toEqual([
      ["openai", "https://api.openai.com/v1"], ["anthropic", "https://api.anthropic.com/v1"],
      ["openrouter", "https://openrouter.ai/api/v1"], ["groq", "https://api.groq.com/openai/v1"], ["custom", null],
    ]);
  });
  it("derives the provider from the host of an existing Base URL (backward compatibility)", () => {
    expect(providerFromBaseUrl("")).toBe("openai");
    expect(providerFromBaseUrl("https://api.openai.com/v1")).toBe("openai");
    expect(providerFromBaseUrl("https://api.anthropic.com/v1/")).toBe("anthropic");
    expect(providerFromBaseUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(providerFromBaseUrl("https://api.groq.com/openai/v1")).toBe("groq");
    expect(providerFromBaseUrl("http://ollama:11434/v1")).toBe("custom");
  });
  it("resolves the Base URL: presets from the catalog, custom from the stored value without a trailing slash", () => {
    expect(resolveBaseUrl("groq", "http://stale")).toBe("https://api.groq.com/openai/v1");
    expect(resolveBaseUrl("custom", "http://ollama:11434/v1/")).toBe("http://ollama:11434/v1");
    expect(hostOf("https://API.openai.com:443/v1")).toBe("api.openai.com");
  });
});

describe("validation", () => {
  it("accepts real model ids (incl. OpenRouter, Ollama tags, Fireworks paths) and rejects junk", () => {
    for (const ok of ["gpt-4o-mini", "anthropic/claude-haiku-4.5", "llama3.1:8b", "accounts/fireworks/models/llama-v3p1-8b"]) expect(modelIdError(ok)).toBeNull();
    for (const bad of ["", "has space", "a".repeat(201), "x\ny", "<script>"]) expect(modelIdError(bad)).not.toBeNull();
  });
  it("accepts http(s) custom URLs only, without credentials, query or fragment", () => {
    expect(baseUrlError("http://ollama:11434/v1")).toBeNull();
    for (const bad of ["ftp://x/v1", "https://u:p@x/v1", "https://x/v1?k=1", "https://x/v1#f", "not a url", "https://x/" + "a".repeat(300)]) expect(baseUrlError(bad)).not.toBeNull();
  });
});

describe("chat wire format — what each provider's API expects", () => {
  const cfg = (provider: "openai" | "anthropic" | "openrouter" | "groq" | "custom", baseUrl: string, model: string) => ({ provider, baseUrl, apiKey: "KEY", model });

  it("Anthropic: native /v1/messages, x-api-key + anthropic-version, system as a top-level string, NO temperature", () => {
    const r = chatRequest(cfg("anthropic", "https://api.anthropic.com/v1", "claude-haiku-5-5"), msgs);
    expect(r.url).toBe("https://api.anthropic.com/v1/messages");
    expect(r.headers).toMatchObject({ "x-api-key": "KEY", "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
    expect(r.headers).not.toHaveProperty("Authorization");
    expect(r.body).toEqual({ model: "claude-haiku-5-5", max_tokens: 300, system: "Be brief", messages: [{ role: "user", content: "Hi" }] });
  });
  it("OpenAI-compatible: /chat/completions with Bearer, system as a message, classic max_tokens + temperature", () => {
    const r = chatRequest(cfg("groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"), msgs);
    expect(r.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(r.headers.Authorization).toBe("Bearer KEY");
    expect(r.body).toEqual({ model: "llama-3.3-70b-versatile", max_tokens: 300, temperature: 0.8, messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Hi" }] });
  });
  it("OpenAI reasoning models keep max_completion_tokens and no temperature", () => {
    const r = chatRequest(cfg("openai", "https://api.openai.com/v1", "gpt-5-mini"), msgs);
    expect(r.body).toMatchObject({ max_completion_tokens: 300 });
    expect(r.body).not.toHaveProperty("temperature");
  });
  it("parses the recorded Anthropic message and the OpenAI-shaped completion", () => {
    expect(parseChatText("anthropic", anthropicMessage)).toBe("OK");
    expect(parseChatText("openai", openaiChat)).toBe("OK");
  });
  it("returns null for an empty or malformed completion and flags a length cut-off (recorded Anthropic max_tokens)", () => {
    expect(parseChatText("anthropic", anthropicTruncated)).toBeNull();
    expect(chatFinishedByLength("anthropic", anthropicTruncated)).toBe(true);
    expect(chatFinishedByLength("anthropic", anthropicMessage)).toBe(false);
    expect(chatFinishedByLength("openai", { choices: [{ message: { content: "" }, finish_reason: "length" }] })).toBe(true);
    expect(parseChatText("openai", { choices: [] })).toBeNull();
    expect(parseChatText("openai", "garbage")).toBeNull();
  });
});

describe("models wire format and parsing", () => {
  it("Anthropic lists with x-api-key and limit=1000; others use Bearer on /models; OpenRouter works without a key", () => {
    expect(modelsRequest("anthropic", "https://api.anthropic.com/v1", "K")).toEqual({
      url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": "K", "anthropic-version": "2023-06-01" } });
    expect(modelsRequest("openai", "https://api.openai.com/v1", "K")).toEqual({ url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer K" } });
    expect(modelsRequest("openrouter", "https://openrouter.ai/api/v1", "")).toEqual({ url: "https://openrouter.ai/api/v1/models", headers: {} });
  });
  it("parses the recorded Anthropic list (id + display_name + context)", () => {
    const m = parseModels("anthropic", anthropicModels);
    expect(m).toHaveLength(14);
    expect(m[0]).toEqual({ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 1000000 });
  });
  it("parses the recorded OpenRouter list with price per 1M tokens", () => {
    const m = parseModels("openrouter", openrouterModels);
    const haiku = m.find((x) => x.id === "anthropic/claude-haiku-4.5")!;
    expect(haiku).toMatchObject({ context: 200000, price_in: 1, price_out: 5 });
    expect(haiku.name).toBeTruthy();
  });
  it("parses OpenAI / Groq lists by id", () => {
    expect(parseModels("openai", openaiModels).map((x) => x.id)).toContain("gpt-4o-mini");
    expect(parseModels("groq", groqModels)[0]).toMatchObject({ id: "llama-3.3-70b-versatile", context: 131072 });
  });
  it("returns [] for a malformed body", () => {
    expect(parseModels("openai", { nope: 1 })).toEqual([]);
    expect(parseModels("openai", null)).toEqual([]);
  });
  it("filters out non-chat models from the recorded OpenAI list but keeps chat and reasoning ones", () => {
    const kept = parseModels("openai", openaiModels).filter((m) => isChatModel(m.id)).map((m) => m.id).sort();
    expect(kept).toEqual(["gpt-4o-mini", "o3-mini"]);
    expect(isChatModel("whisper-large-v3")).toBe(false);
    expect(isChatModel("llama-3.3-70b-versatile")).toBe(true);
  });
});
