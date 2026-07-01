import { getConfig } from "@/lib/settings/config";

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
 */
export async function chatComplete(opts: ChatCompleteOptions): Promise<string | null> {
  const { system, user, maxTokens = 300, temperature = 0.8, timeoutMs = 10_000 } = opts;

  const apiKey = await getConfig("AI_API_KEY");
  if (!apiKey) return null;

  const model = (await getConfig("AI_MODEL")) || DEFAULT_MODEL;
  const baseUrl = (await getConfig("AI_BASE_URL")) || DEFAULT_BASE_URL;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content?.trim();
    return content && content.length > 0 ? content : null;
  } catch {
    return null;
  }
}
