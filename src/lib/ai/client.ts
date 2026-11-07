import { configField } from "@/lib/settings/registry";
import { getConfig } from "@/lib/settings/config";
import { logGeneration } from "@/lib/ai/generation-log";
import { aiFetch } from "@/lib/ai/net";
import { AI_PROVIDER_IDS, chatRequest, parseChatText, providerFromBaseUrl, resolveBaseUrl, isReasoningModel, type AiProviderId } from "@/lib/ai/providers";

export { isReasoningModel };

// Defaults mirror the env schema (env.ts), since getConfig falls back to raw process.env (no zod
// defaults): an unset model/base-url resolves to "" here, so we apply the same defaults.
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface Provider {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: AiProviderId;
  id?: string;
  scope?: string | null;
}

// Parse legacy fallback entries, including optional native providers; skip malformed entries.
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
    const provider = typeof o.provider === "string" && AI_PROVIDER_IDS.includes(o.provider as AiProviderId) ? o.provider as AiProviderId : undefined;
    providers.push({ apiKey, model, baseUrl: provider ? resolveBaseUrl(provider, baseUrl) : baseUrl, ...(provider ? { provider } : {}) });
  }
  return providers;
}

// Use the instance list, or environment defaults when the list is empty.
export async function buildProviderChain(): Promise<Provider[]> {
  if (process.env.DATABASE_URL) {
    const saved = await (await import("./provider-store")).storedProviderChain();
    if (saved) return saved;
  }

  const environmentOnly = !!process.env.DATABASE_URL;
  const [{ apiKey, baseUrl, model, provider }, fallbacks] = await Promise.all([readAiConfig(environmentOnly), environmentOnly ? process.env.AI_FALLBACKS ?? "" : getConfig("AI_FALLBACKS")]);
  const chain: Provider[] = [];
  if (apiKey) chain.push({ apiKey, provider, baseUrl: baseUrl || DEFAULT_BASE_URL, model: model || DEFAULT_MODEL });
  chain.push(...parseFallbacks(fallbacks));
  return chain;
}

// Read legacy instance settings and environment defaults, with preset URLs taken from the catalog.
export async function readAiConfig(environmentOnly = false): Promise<{ provider: AiProviderId; baseUrl: string; apiKey: string; model: string }> {
  const read = environmentOnly ? async (key: string) => [key, ...(configField(key)?.aliases ?? [])].map(name => process.env[name]).find(Boolean) ?? "" : getConfig;
  const [apiKey, storedBaseUrl, model, storedProvider] = await Promise.all([
    read("AI_API_KEY"), read("AI_BASE_URL"), read("AI_MODEL"), read("AI_PROVIDER"),
  ]);
  const provider = (AI_PROVIDER_IDS as readonly string[]).includes(storedProvider) ? (storedProvider as AiProviderId) : providerFromBaseUrl(storedBaseUrl);
  return { provider, baseUrl: resolveBaseUrl(provider, storedBaseUrl), apiKey, model };
}

// Check presence for this workspace without opening stored provider keys.
export async function isAiConfigured(): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    const configured = await (await import("./provider-store")).hasStoredProviders();
    if (configured !== null) return configured;
  }
  return (await buildProviderChain()).length > 0;
}

export interface ChatCompleteOptions {
  /** The workspace owning this generation and its provider chain. */
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

type Attempt = { response: string | null; error: string | null; status: import("./provider-store").ProviderStatus; stop?: boolean };
async function attemptCompletion(provider: Provider, system: string, user: string, maxTokens: number, temperature: number, timeoutMs: number): Promise<Attempt> {
  const { fromStatus, fromThrown } = await import("./models");
  try {
    const kind = provider.provider ?? providerFromBaseUrl(provider.baseUrl);
    const req = chatRequest({ ...provider, provider: kind }, { system, user, maxTokens, temperature });
    const res = await aiFetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) }, { deadlineMs: timeoutMs });
    if (!res.ok) {
      const code = fromStatus(res.status, "model_not_found", await res.text().catch(() => "")).code;
      const stop = [400, 413, 422].includes(res.status) && code !== "no_credits";
      return { response: null, error: `HTTP ${res.status}`, status: stop ? "invalid_request" : code === "no_models_endpoint" ? "bad_response" : code, stop };
    }
    const content = parseChatText(kind, await res.json().catch(() => null));
    return content ? { response: content.replaceAll(provider.apiKey, "[redacted]"), error: null, status: "ok" } : { response: null, error: "empty completion", status: "bad_response" };
  } catch (error) {
    const code = fromThrown(error).code;
    return { response: null, error: code, status: code === "no_models_endpoint" ? "bad_response" : code, stop: code === "blocked_target" };
  }
}

export async function chatComplete(opts: ChatCompleteOptions): Promise<string | null> {
  const { workspaceId, kind, conversationId, system, user, maxTokens = 300, temperature = 0.8, timeoutMs = 10_000 } = opts;
  if (!system.trim() || !user.trim() || !Number.isInteger(maxTokens) || maxTokens <= 0 || !Number.isFinite(temperature)) return null;
  const chain = await buildProviderChain();
  for (const provider of chain) {
    const startedAt = Date.now();
    const { response, error, status, stop } = await attemptCompletion(provider, system, user, maxTokens, temperature, timeoutMs);
    const redact = (s: string) => chain.reduce((s, p) => s.replaceAll(p.apiKey, "[redacted]"), s);
    await logGeneration({ workspaceId, kind, model: provider.model, system: redact(system), user: redact(user), response: response ? redact(response) : null, error, durationMs: Date.now() - startedAt, conversationId });
    if (provider.id) await (await import("./provider-store")).recordProviderOutcome(provider.scope ?? null, provider.id, status);
    if (response) return redact(response);
    if (stop) return null;
  }
  return null;
}
