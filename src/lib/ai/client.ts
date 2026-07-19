import { getConfig } from "@/lib/settings/config";
import { logGeneration } from "@/lib/ai/generation-log";

// Defaults mirror the env schema (env.ts), since getConfig falls back to raw process.env (no zod
// defaults): an unset model/base-url resolves to "" here, so we apply the same defaults.
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Whether an AI provider is configured (an API key is set — via Settings or the `AI_API_KEY` env).
 * The single source of truth for "can AI actually run": the UI disables AI actions and the API
 * reports `ai_configured` off this, mirroring what makes `chatComplete` return `null`. Model and
 * base-url have defaults, so only the key gates availability.
 */
export async function isAiConfigured(): Promise<boolean> {
  return (await getConfig("AI_API_KEY")) !== "";
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

export async function chatComplete(opts: ChatCompleteOptions): Promise<string | null> {
  const { workspaceId, kind, conversationId, system, user, maxTokens = 300, temperature = 0.8, timeoutMs = 10_000 } = opts;

  const apiKey = await getConfig("AI_API_KEY");
  if (!apiKey) return null; // not configured — not a real attempt, nothing to log

  const model = (await getConfig("AI_MODEL")) || DEFAULT_MODEL;
  const baseUrl = (await getConfig("AI_BASE_URL")) || DEFAULT_BASE_URL;

  const startedAt = Date.now();
  let response: string | null = null;
  let error: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        ...samplingParams(model, maxTokens, temperature),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else {
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content && content.length > 0) response = content;
      else error = "empty completion";
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await logGeneration({ workspaceId, kind, model, system, user, response, error, durationMs: Date.now() - startedAt, conversationId });
  return response;
}
