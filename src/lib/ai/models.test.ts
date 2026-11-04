import { describe, it, expect, beforeEach } from "vitest";
import anthropicModels from "./__fixtures__/anthropic-models.json";
import anthropicMessage from "./__fixtures__/anthropic-message.json";
import anthropicTruncated from "./__fixtures__/anthropic-message-truncated.json";
import openaiModels from "./__fixtures__/openai-models.json";
import openrouterModels from "./__fixtures__/openrouter-models.json";
import { listModels, testConnection, clearModelCache, AiError } from "./models";

type Call = { url: string; headers: Record<string, string>; body?: string };
function fakeFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const call = { url, headers: init.headers as Record<string, string>, body: init.body as string | undefined };
    calls.push(call);
    return responder(call);
  };
  return { calls, fetchImpl };
}
const openai = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" };
const code = async (p: Promise<unknown>) => p.then(() => "no error", (e) => (e instanceof AiError ? `${e.code}:${e.httpStatus ?? ""}` : `other:${e}`));

beforeEach(() => clearModelCache());

describe("listModels", () => {
  it("fetches, filters non-chat models and reports how many were hidden", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(openaiModels));
    const r = await listModels(openai, { fetchImpl });
    expect(r.models.map((m) => m.id).sort()).toEqual(["gpt-4o-mini", "o3-mini"]);
    expect(r).toMatchObject({ cached: false, filtered_out: 5 });
    expect(calls).toEqual([{ url: "https://api.openai.com/v1/models", headers: { Authorization: "Bearer sk-test" }, body: undefined }]);
  });

  it("serves the second call from the 24 h cache, `all` reuses it, `refresh` bypasses it", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(openaiModels));
    const now = 1_000;
    await listModels(openai, { fetchImpl, now: () => now });
    const again = await listModels(openai, { fetchImpl, now: () => now + 3600_000 });
    expect(again.cached).toBe(true);
    expect((await listModels(openai, { fetchImpl, all: true, now: () => now })).models).toHaveLength(7);
    expect(calls).toHaveLength(1);
    await listModels(openai, { fetchImpl, refresh: true, now: () => now });
    expect(calls).toHaveLength(2);
    await listModels(openai, { fetchImpl, now: () => now + 25 * 3600_000 });
    expect(calls).toHaveLength(3);
  });

  it("keeps lists of different keys apart", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(openaiModels));
    await listModels(openai, { fetchImpl });
    await listModels({ ...openai, apiKey: "sk-other" }, { fetchImpl });
    expect(calls).toHaveLength(2);
  });

  it("lists OpenRouter without a key (public list), but OpenAI/Anthropic/Groq require one before any request", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(openrouterModels));
    const r = await listModels({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "" }, { fetchImpl });
    expect(r.models.length).toBeGreaterThan(0);
    expect(calls[0]!.headers).toEqual({});
    expect(await code(listModels({ ...openai, apiKey: "" }, { fetchImpl }))).toBe("invalid_key:");
    expect(calls).toHaveLength(1);
  });

  it("follows Anthropic pagination (has_more / last_id → after_id)", async () => {
    const page1 = { ...anthropicModels, data: anthropicModels.data.slice(0, 10), has_more: true, last_id: "claude-opus-5" };
    const page2 = { ...anthropicModels, data: anthropicModels.data.slice(10), has_more: false };
    const { fetchImpl, calls } = fakeFetch((c) => Response.json(c.url.includes("after_id=claude-opus-5") ? page2 : page1));
    const r = await listModels({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "k" }, { fetchImpl, all: true });
    expect(r.models).toHaveLength(14);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
  });

  it.each([
    [401, "invalid_key:401"], [403, "invalid_key:403"], [429, "rate_limited:429"], [500, "bad_response:500"],
  ])("maps HTTP %i to its error code without exposing the provider body", async (status, expected) => {
    const { fetchImpl } = fakeFetch(() => new Response("secret provider text sk-leak", { status }));
    expect(await code(listModels(openai, { fetchImpl }))).toBe(expected);
    await listModels(openai, { fetchImpl }).catch((e: AiError) => expect(JSON.stringify(e) + e.message).not.toContain("sk-leak"));
  });

  it("a 429 with OpenAI's out-of-credits body is no_credits, not a rate limit (recorded PROD 2026-11-04)", async () => {
    const body = JSON.stringify({ error: { message: "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.", type: "insufficient_quota", param: null, code: "credit_balance_exhausted" } });
    expect(await code(listModels(openai, { fetchImpl: fakeFetch(() => new Response(body, { status: 429 })).fetchImpl }))).toBe("no_credits:429");
    const t = await testConnection({ ...openai, model: "gpt-5.6-terra" }, { fetchImpl: fakeFetch(() => new Response(body, { status: 429 })).fetchImpl });
    expect(t).toEqual({ ok: false, error: { code: "no_credits", http_status: 429 } });
  });

  it("a custom server without /models answers no_models_endpoint; a non-JSON body is bad_response", async () => {
    const custom = { provider: "custom" as const, baseUrl: "http://ollama:11434/v1", apiKey: "x" };
    expect(await code(listModels(custom, { fetchImpl: fakeFetch(() => new Response("nf", { status: 404 })).fetchImpl }))).toBe("no_models_endpoint:404");
    expect(await code(listModels(openai, { fetchImpl: fakeFetch(() => new Response("<html>")).fetchImpl }))).toBe("bad_response:200");
  });

  it.each([
    ["refused loopback address: 127.0.0.1", "blocked_target:"], ["request deadline exceeded", "timeout:"],
    ["request timed out", "timeout:"], ["getaddrinfo ENOTFOUND nope.invalid", "unreachable:"],
  ])("maps a thrown %s to %s", async (message, expected) => {
    const { fetchImpl } = fakeFetch(() => { throw new Error(message); });
    expect(await code(listModels(openai, { fetchImpl }))).toBe(expected);
  });
});

describe("testConnection", () => {
  const claude = { provider: "anthropic" as const, baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-haiku-5-5" };

  it("sends a minimal Anthropic /messages request (no temperature) and passes on the recorded success", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json(anthropicMessage));
    const r = await testConnection(claude, { fetchImpl });
    expect(r).toMatchObject({ ok: true, model: "claude-haiku-5-5" });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ model: "claude-haiku-5-5", max_tokens: 16, system: "Reply with OK.", messages: [{ role: "user", content: "Reply with OK." }] });
  });

  it("gives reasoning models a bigger budget", async () => {
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ choices: [{ message: { content: "OK" } }] }));
    await testConnection({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-5-mini" }, { fetchImpl });
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ max_completion_tokens: 64 });
  });

  it("reports ok + truncated when the budget ran out (recorded stop_reason max_tokens), bad_response when empty for another reason", async () => {
    expect(await testConnection(claude, { fetchImpl: fakeFetch(() => Response.json(anthropicTruncated)).fetchImpl })).toMatchObject({ ok: true, truncated: true });
    expect(await testConnection(claude, { fetchImpl: fakeFetch(() => Response.json({ content: [], stop_reason: "end_turn" })).fetchImpl }))
      .toEqual({ ok: false, error: { code: "bad_response", http_status: 200 } });
  });

  it("maps 401 to invalid_key and 404 to model_not_found (recorded Anthropic not_found body)", async () => {
    const r401 = await testConnection(claude, { fetchImpl: fakeFetch(() => Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })).fetchImpl });
    expect(r401).toEqual({ ok: false, error: { code: "invalid_key", http_status: 401 } });
    const r404 = await testConnection(claude, { fetchImpl: fakeFetch(() => Response.json({ type: "error", error: { type: "not_found_error", message: "model: nope-1" } }, { status: 404 })).fetchImpl });
    expect(r404).toEqual({ ok: false, error: { code: "model_not_found", http_status: 404 } });
  });

  it("returns a blocked_target result instead of throwing", async () => {
    const r = await testConnection(claude, { fetchImpl: fakeFetch(() => { throw new Error("refused link_local address: 169.254.169.254"); }).fetchImpl });
    expect(r).toEqual({ ok: false, error: { code: "blocked_target" } });
  });
});
