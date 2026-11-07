import { configField } from "@/lib/settings/registry";
import { ApiError } from "@/lib/api/response";
import { readAiConfig, parseFallbacks } from "./client";
import { listModels, testConnection, AiError, type AiErrorCode, type ModelList, type TestResult } from "./models";
import { blockedTargetHint } from "./net";
import { PROVIDERS, baseUrlError, hostOf, modelIdError, preset, resolveBaseUrl, AI_PROVIDER_IDS, type AiProviderId } from "./providers";

// Legacy self-hosted settings API; ordered lists are managed by provider-store.

export interface AiSettingsView {
  configured: boolean;
  provider: AiProviderId;
  base_url: string;
  model: string;
  api_key: { set: boolean; source: "db" | "env" | "unset"; hint: string | null };
  sources: { provider: string; base_url: string; model: string };
  fallbacks: { count: number };
  providers: Array<{ id: string; label: string; base_url: string | null; models_need_key: boolean; key_url?: string }>;
}

export async function aiSettingsView(): Promise<AiSettingsView> {
  const store = await import("./provider-store");
  await store.migrateInstanceProviders();
  const [cfg, saved] = await Promise.all([readAiConfig(true), store.listProviders(null)]);
  const first = saved[0], fallbacksRaw = process.env.AI_FALLBACKS ?? "";
  const src = (key: string) => [key, ...(configField(key)?.aliases ?? [])].some(name => process.env[name]) ? "env" as const : "unset" as const;
  const derived = (key: string, fallback: string) => src(key) === "unset" ? fallback : "env";
  return {
    configured: !!first || !!cfg.apiKey || parseFallbacks(fallbacksRaw).length > 0,
    provider: first?.provider ?? cfg.provider,
    base_url: first?.base_url ?? cfg.baseUrl,
    model: first?.model ?? (cfg.model || "gpt-4o-mini"),
    api_key: first ? { set: true, source: "db", hint: first.api_key_hint || null } : { set: !!cfg.apiKey, source: src("AI_API_KEY"), hint: cfg.apiKey.length >= 20 ? cfg.apiKey.slice(-4) : null },
    sources: first ? { provider: "db", model: "db", base_url: preset(first.provider).baseUrl ? "derived" : "db" } : { provider: derived("AI_PROVIDER", "derived"), base_url: preset(cfg.provider).baseUrl ? "derived" : derived("AI_BASE_URL", "default"), model: derived("AI_MODEL", "default") },
    fallbacks: { count: first ? saved.length - 1 : parseFallbacks(fallbacksRaw).length },
    providers: PROVIDERS.map((p) => ({ id: p.id, label: p.label, base_url: p.baseUrl, models_need_key: p.modelsNeedKey, ...(p.keyUrl ? { key_url: p.keyUrl } : {}) })),
  };
}

export function aiErrorMessage(code: AiErrorCode, host: string, status?: number): string {
  switch (code) {
    case "invalid_key": return "The API key is invalid or has no access. Check that you copied all of it.";
    case "model_not_found": return "This model does not exist at the provider, or the key has no access to it.";
    case "rate_limited": return "The provider rejected the request (rate limit). Try again shortly.";
    case "no_credits": return "The provider account has no credits left. Add credits in the provider's billing settings, then test again.";
    case "timeout": return "The provider did not answer in time.";
    case "unreachable": return `Could not connect to ${host}. Check the Base URL.`;
    case "blocked_target": return blockedTargetHint(host);
    case "no_models_endpoint": return "This server does not list models. Type the model name yourself.";
    case "bad_response": return `The provider answered in an unexpected way${status ? ` (HTTP ${status})` : ""}.`;
  }
}

export interface Candidate { provider?: AiProviderId; api_key?: string; base_url?: string | null; model?: string }
export type Failure = { ok: false; status: 422; code: string; message: string; details?: { http_status?: number } };
export type Access = { provider: AiProviderId; baseUrl: string; apiKey: string; model: string; keyGiven: boolean };

const fail = (code: string, message: string, http_status?: number): Failure => ({ ok: false, status: 422, code, message, ...(http_status ? { details: { http_status } } : {}) });

/**
 * Merge a candidate over the saved config. The saved key travels only with the SAME provider and host it was
 * saved for; for a different target the candidate must bring its own key, otherwise `apiKey` stays empty.
 */
export async function resolveAccess(c: Candidate): Promise<{ ok: true; access: Access } | Failure> {
  const store = await import("./provider-store");
  await store.migrateInstanceProviders();
  const cur = await store.savedInstanceConfig() ?? await readAiConfig(true);
  const provider = c.provider ?? cur.provider;
  if (c.base_url && preset(provider).baseUrl) return fail("BASE_URL_NOT_ALLOWED", "Base URL can only be set for the custom provider.");
  const customUrl = c.base_url ?? (cur.provider === "custom" ? cur.baseUrl : "");
  const baseUrl = resolveBaseUrl(provider, customUrl);
  if (provider === "custom") {
    if (!baseUrl) return fail("BASE_URL_REQUIRED", "The custom provider needs a Base URL.");
    const bad = baseUrlError(baseUrl);
    if (bad) return fail("INVALID_BASE_URL", bad);
  }
  const sameTarget = provider === cur.provider && baseUrl === cur.baseUrl;
  return { ok: true, access: { provider, baseUrl, apiKey: c.api_key ?? (sameTarget ? cur.apiKey : ""), model: c.model ?? cur.model, keyGiven: !!c.api_key } };
}

const needKey = () => fail("API_KEY_REQUIRED", "Enter the API key for this provider. The saved key is only ever sent to the provider and host it was saved for.");

export async function listAiModels(c: Candidate, o: { refresh?: boolean; all?: boolean }): Promise<{ ok: true; list: ModelList } | Failure> {
  const r = await resolveAccess(c);
  if (!r.ok) return r;
  try {
    return { ok: true, list: await listModels(r.access, o) };
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("unreachable");
    return fail(err.code, aiErrorMessage(err.code, hostOf(r.access.baseUrl), err.httpStatus), err.httpStatus);
  }
}

export async function testAiSettings(c: Candidate): Promise<{ ok: true; result: TestResult } | Failure> {
  const r = await resolveAccess(c);
  if (!r.ok) return r;
  if (!r.access.apiKey) return needKey();
  const model = r.access.model || "gpt-4o-mini";
  const bad = modelIdError(model);
  if (bad) return fail("INVALID_MODEL", bad);
  const result = await testConnection({ ...r.access, model });
  if (!result.ok) result.error.message = aiErrorMessage(result.error.code, hostOf(r.access.baseUrl), result.error.http_status);
  return { ok: true, result };
}

/** Save the provider config only after a successful connection test. */
export async function saveAiSettings(c: Candidate & { model: string; verify?: true }): Promise<{ ok: true; keyChanged: boolean } | Failure> {
  const bad = modelIdError(c.model);
  if (bad) return fail("INVALID_MODEL", bad);
  if (c.provider && !AI_PROVIDER_IDS.includes(c.provider)) return fail("INVALID_PROVIDER", "Unknown provider.");
  const r = await resolveAccess(c);
  if (!r.ok) return r;
  const { provider, baseUrl, apiKey } = r.access;
  if (!apiKey) return needKey();
  const store = await import("./provider-store");
  const [main] = await store.listProviders(null);
  try {
    await store.saveProvider(null, { provider, model: c.model, api_key: apiKey, ...(provider === "custom" ? { base_url: baseUrl } : {}) }, main?.id);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 422) throw e;
    const status = (e as ApiError & { httpStatus?: number }).httpStatus;
    return fail(e.code, aiErrorMessage(e.code as AiErrorCode, hostOf(baseUrl), status) || e.message, status);
  }
  return { ok: true, keyChanged: r.access.keyGiven };
}

/** Remove Main and promote the next saved provider, or return to environment defaults. */
export async function clearAiSettings(): Promise<void> {
  const store = await import("./provider-store");
  await store.migrateInstanceProviders();
  const [main] = await store.listProviders(null);
  if (main) await store.removeProvider(null, main.id);
}
