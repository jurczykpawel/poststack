// AIPROVIDER1: the AI provider catalog + the wire format of each provider (request builders and response
// parsers). Pure functions, no I/O — the dashboard, the REST API and the production client share them.

export const AI_PROVIDER_IDS = ["openai", "anthropic", "openrouter", "groq", "custom"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface ProviderPreset {
  id: AiProviderId;
  label: string;
  baseUrl: string | null;
  /** Whether the model list needs a valid key (OpenRouter's list is public). */
  modelsNeedKey: boolean;
  keyUrl?: string;
}

export const PROVIDERS: readonly ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", modelsNeedKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1", modelsNeedKey: true, keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelsNeedKey: false, keyUrl: "https://openrouter.ai/keys" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelsNeedKey: true, keyUrl: "https://console.groq.com/keys" },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: null, modelsNeedKey: false },
];

export const preset = (id: AiProviderId): ProviderPreset => PROVIDERS.find((p) => p.id === id)!;
const ANTHROPIC_VERSION = "2023-06-01";

export const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

/** Existing installs have no AI_PROVIDER: infer it from the host of their Base URL (empty = OpenAI). */
export function providerFromBaseUrl(baseUrl: string): AiProviderId {
  if (!baseUrl.trim()) return "openai";
  const host = hostOf(baseUrl);
  return PROVIDERS.find((p) => p.baseUrl && hostOf(p.baseUrl) === host)?.id ?? "custom";
}

/** Presets always use the catalog URL (so a stale stored URL cannot redirect them); custom uses the stored one. */
export function resolveBaseUrl(provider: AiProviderId, custom: string): string {
  return preset(provider).baseUrl ?? custom.trim().replace(/\/+$/, "");
}

export function modelIdError(model: string): string | null {
  return /^[\w.:/@+-]{1,200}$/.test(model) ? null : "Model must be 1–200 characters: letters, digits and . : / @ + - _";
}

export function baseUrlError(url: string): string | null {
  if (url.length > 300) return "Base URL is too long (max 300 characters)";
  let u: URL;
  try { u = new URL(url); } catch { return "Base URL is not a valid URL"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Base URL must be http(s)";
  if (u.username || u.password) return "Base URL must not contain credentials";
  if (u.search || u.hash) return "Base URL must not contain a query or fragment";
  return null;
}

/** OpenAI's GPT-5 and o-series ("reasoning") models renamed `max_tokens` → `max_completion_tokens` and accept
 *  only the default temperature. Matches an optional `provider/` prefix (OpenRouter ids like `openai/gpt-5.6`). */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)(o[1-9]|gpt-5)/.test(model);
}

export interface ProviderCall { provider: AiProviderId; baseUrl: string; apiKey: string; model: string }
export interface ChatInput { system: string; user: string; maxTokens: number; temperature: number }
export interface WireRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export function chatRequest(c: ProviderCall, i: ChatInput): WireRequest {
  if (c.provider === "anthropic") {
    // Measured 2026-11-03: Claude 5 answers `temperature` with HTTP 400 ("deprecated for this model"), so it is never sent.
    return {
      url: `${c.baseUrl}/messages`,
      headers: { "Content-Type": "application/json", "x-api-key": c.apiKey, "anthropic-version": ANTHROPIC_VERSION },
      body: { model: c.model, max_tokens: i.maxTokens, system: i.system, messages: [{ role: "user", content: i.user }] },
    };
  }
  return {
    url: `${c.baseUrl}/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.apiKey}` },
    body: {
      model: c.model,
      ...(isReasoningModel(c.model) ? { max_completion_tokens: i.maxTokens } : { max_tokens: i.maxTokens, temperature: i.temperature }),
      messages: [{ role: "system", content: i.system }, { role: "user", content: i.user }],
    },
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- provider responses are untrusted JSON, narrowed below
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** The assistant text of a completion, or null when it is empty / not the expected shape. */
export function parseChatText(provider: AiProviderId, json: unknown): string | null {
  const j = obj(json);
  const text = provider === "anthropic"
    ? (Array.isArray(j.content) ? j.content : []).map((b: Json) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("")
    : j.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

/** The model stopped because it ran out of output tokens (e.g. reasoning ate the budget). */
export function chatFinishedByLength(provider: AiProviderId, json: unknown): boolean {
  const j = obj(json);
  return provider === "anthropic" ? j.stop_reason === "max_tokens" : j.choices?.[0]?.finish_reason === "length";
}

export function modelsRequest(provider: AiProviderId, baseUrl: string, apiKey: string): { url: string; headers: Record<string, string> } {
  if (provider === "anthropic") return { url: `${baseUrl}/models?limit=1000`, headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION } };
  return { url: `${baseUrl}/models`, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} };
}

export interface AiModel { id: string; name?: string; context?: number; price_in?: number; price_out?: number }

const perMillion = (v: unknown) => (v === undefined || v === null || isNaN(Number(v)) ? undefined : Number((Number(v) * 1e6).toFixed(4)));

export function parseModels(provider: AiProviderId, json: unknown): AiModel[] {
  const data = obj(json).data;
  if (!Array.isArray(data)) return [];
  const out: AiModel[] = [];
  for (const m of data as Json[]) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const ctx = m.max_input_tokens ?? m.context_length ?? m.context_window;
    const model: AiModel = { id: m.id };
    const name = provider === "anthropic" ? m.display_name : m.name;
    if (typeof name === "string" && name) model.name = name;
    if (typeof ctx === "number") model.context = ctx;
    if (provider === "openrouter") {
      const pin = perMillion(m.pricing?.prompt), pout = perMillion(m.pricing?.completion);
      if (pin !== undefined) model.price_in = pin;
      if (pout !== undefined) model.price_out = pout;
    }
    out.push(model);
  }
  return out;
}

/** Hides embeddings, speech, image, moderation and realtime models from the picker. */
export const isChatModel = (id: string): boolean => !/embed|whisper|tts|dall-e|image|moderation|realtime|transcribe|audio|guard|rerank|davinci|babbage|sora/i.test(id);
