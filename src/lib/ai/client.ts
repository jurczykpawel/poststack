import { getConfig } from "@/lib/settings/config";
import { logGeneration } from "@/lib/ai/generation-log";

// Defaults mirror the env schema (env.ts), since getConfig falls back to raw process.env (no zod
// defaults): an unset model/base-url resolves to "" here, so we apply the same defaults.
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A single OpenAI-compatible provider in the fallback chain. */
export interface Provider {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Parse AI_FALLBACKS — a JSON array of `{ apiKey, model, baseUrl? }` — into providers. Malformed JSON,
 * a non-array, or entries missing apiKey/model are skipped and never throw: a broken fallback config
 * must never take down the primary provider. `baseUrl` defaults to OpenAI when omitted.
 */
export function parseFallbacks(raw: string): Provider[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: Provider[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : "";
    const model = typeof o.model === "string" ? o.model.trim() : "";
    if (!apiKey || !model) continue;
    const baseUrl = typeof o.baseUrl === "string" && o.baseUrl.trim() ? o.baseUrl.trim() : DEFAULT_BASE_URL;
    providers.push({ apiKey, model, baseUrl });
  }
  return providers;
}

/**
 * The ordered provider chain that {@link chatComplete} walks: the primary provider
 * (AI_API_KEY / AI_BASE_URL / AI_MODEL) first, then every AI_FALLBACKS entry. The primary is included
 * only when its key is set, so a fallback-only setup is valid too. This is what makes the whole
 * feature — free→paid tiers, or resilience against a provider outage / rate-limit / bad response —
 * a pure config change: each provider is tried in turn until one returns a usable completion.
 */
export async function buildProviderChain(): Promise<Provider[]> {
  const [apiKey, baseUrl, model, fallbacks] = await Promise.all([
    getConfig("AI_API_KEY"),
    getConfig("AI_BASE_URL"),
    getConfig("AI_MODEL"),
    getConfig("AI_FALLBACKS"),
  ]);
  const chain: Provider[] = [];
  if (apiKey) chain.push({ apiKey, baseUrl: baseUrl || DEFAULT_BASE_URL, model: model || DEFAULT_MODEL });
  chain.push(...parseFallbacks(fallbacks));
  return chain;
}

/**
 * Whether an AI provider is configured — the chain has at least one provider (a primary key, or any
 * AI_FALLBACKS entry). The single source of truth for "can AI actually run": the UI disables AI
 * actions and the API reports `ai_configured` off this, mirroring what makes `chatComplete` return
 * `null` (an empty chain).
 */
export async function isAiConfigured(): Promise<boolean> {
  return (await buildProviderChain()).length > 0;
}

export interface ChatCompleteOptions {
  /** Which workspace this call is on behalf of (AI_API_KEY itself is instance-wide/BYOK, but the
   *  generation log — ADLOG1 — is workspace-scoped so an operator can see their own traffic). */
  workspaceId: string;
  /** Which feature made this call — labels the log entry (draft vs rephrase). */
  kind: "draft" | "rephrase";
  /** ADLOG2: the inbox conversation this call was made for — logged so the generation-log panel
   *  can link straight to it. Absent for a call with no live conversation to attribute it to. */
  conversationId?: string;
  /** System prompt. */
  system: string;
  /** User message. */
  user: string;
  /** Max tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/**
 * Shared LLM chat-completions client. Provider-agnostic (any OpenAI-compatible chat-completions
 * endpoint, set via AI_BASE_URL + AI_MODEL, key via AI_API_KEY — all resolved through getConfig).
 * Best-effort: returns `null` if no key is configured, the call fails (non-2xx / throw / timeout),
 * or the completion is empty. Keeps callers free of any provider-specific code.
 *
 * ADLOG1: every real attempt (i.e. past the "no key configured" gate) is logged — exact system/user
 * sent, exact response or failure reason, model, duration — regardless of outcome, so a "why did the
 * model say that" question never requires re-reading code to answer.
 */
/**
 * OpenAI's GPT-5 and o-series ("reasoning") models renamed `max_tokens` → `max_completion_tokens`
 * and reject any non-default `temperature` (only 1 is allowed). Detect them by name so they work
 * through this shared OpenAI-compatible client, while every other model — gpt-4o, plus non-OpenAI
 * providers reached via AI_BASE_URL (Groq / Ollama / OpenRouter / a Claude proxy) — keeps the classic
 * `max_tokens` + `temperature` shape it already accepts. Matches an optional `provider/` prefix so an
 * OpenRouter id like `openai/gpt-5.6-terra` is caught too.
 */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)(o[1-9]|gpt-5)/.test(model);
}

/** The token-limit + temperature params for a model, in the shape that model's API accepts. */
function samplingParams(model: string, maxTokens: number, temperature: number): Record<string, number> {
  return isReasoningModel(model)
    ? { max_completion_tokens: maxTokens } // temperature omitted → provider default (1), the only value these accept
    : { max_tokens: maxTokens, temperature };
}

/**
 * Run ONE provider attempt. Returns the completion text, or `null` with the failure reason — a non-2xx
 * (any status), a thrown/timed-out request, or an empty/malformed completion all count as failures, so
 * the caller can fall through to the next provider. Never throws.
 */
async function attemptCompletion(
  provider: Provider,
  system: string,
  user: string,
  maxTokens: number,
  temperature: number,
  timeoutMs: number,
): Promise<{ response: string | null; error: string | null }> {
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        ...samplingParams(provider.model, maxTokens, temperature),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { response: null, error: `HTTP ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (content && content.length > 0) return { response: content, error: null };
    return { response: null, error: "empty completion" };
  } catch (err) {
    return { response: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function chatComplete(opts: ChatCompleteOptions): Promise<string | null> {
  const { workspaceId, kind, conversationId, system, user, maxTokens = 300, temperature = 0.8, timeoutMs = 10_000 } = opts;

  const chain = await buildProviderChain();
  if (chain.length === 0) return null; // not configured — not a real attempt, nothing to log

  // Walk the chain: the first provider to return a usable completion wins. EVERY attempt — success or
  // failure — is logged (ADLOG1) with that provider's model + the exact failure reason, so a
  // fallthrough is fully visible. Fall through on ANY failure (bad status, outage, timeout, empty
  // completion), regardless of cause, so a reply keeps generating as long as one provider is healthy.
  for (const provider of chain) {
    const startedAt = Date.now();
    const { response, error } = await attemptCompletion(provider, system, user, maxTokens, temperature, timeoutMs);
    await logGeneration({ workspaceId, kind, model: provider.model, system, user, response, error, durationMs: Date.now() - startedAt, conversationId });
    if (response) return response;
  }
  return null;
}
