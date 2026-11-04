import { configStatus, setConfigs, clearConfig, getConfig } from "@/lib/settings/config";
import { readAiConfig, parseFallbacks, isAiConfigured } from "./client";
import { listModels, testConnection, AiError, type AiErrorCode, type ModelList, type TestResult } from "./models";
import { blockedTargetHint } from "./net";
import { PROVIDERS, baseUrlError, hostOf, modelIdError, preset, resolveBaseUrl, AI_PROVIDER_IDS, type AiProviderId } from "./providers";

// AIPROVIDER1: the one place that reads/validates/saves the instance AI provider config. The dashboard form and
// the REST API (/api/v1/settings/ai) both call these functions, so the rules (above all: the saved key is never
// sent to a different provider or host) live in exactly one spot.

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
  const [cfg, status, fallbacksRaw, configured] = await Promise.all([readAiConfig(), configStatus(), getConfig("AI_FALLBACKS"), isAiConfigured()]);
  const src = (key: string) => status.find((f) => f.key === key)?.source ?? "unset";
  const derived = (key: string, fallback: string) => (src(key) === "unset" ? fallback : src(key));
  return {
    configured,
    provider: cfg.provider,
    base_url: cfg.baseUrl,
    model: cfg.model || "gpt-4o-mini",
    api_key: { set: !!cfg.apiKey, source: src("AI_API_KEY"), hint: cfg.apiKey.length >= 20 ? cfg.apiKey.slice(-4) : null },
    sources: { provider: derived("AI_PROVIDER", "derived"), base_url: preset(cfg.provider).baseUrl ? "derived" : derived("AI_BASE_URL", "default"), model: derived("AI_MODEL", "default") },
    fallbacks: { count: parseFallbacks(fallbacksRaw).length },
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
  const cur = await readAiConfig();
  const provider = c.provider ?? cur.provider;
  if (c.base_url && preset(provider).baseUrl) return fail("BASE_URL_NOT_ALLOWED", "Base URL can only be set for the custom provider.");
  const customUrl = c.base_url ?? (cur.provider === "custom" ? cur.baseUrl : "");
  const baseUrl = resolveBaseUrl(provider, customUrl);
  if (provider === "custom") {
    if (!baseUrl) return fail("BASE_URL_REQUIRED", "The custom provider needs a Base URL.");
    const bad = baseUrlError(baseUrl);
    if (bad) return fail("INVALID_BASE_URL", bad);
  }
  const sameTarget = provider === cur.provider && hostOf(baseUrl) === hostOf(cur.baseUrl);
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

/** Save the provider config. `verify` (default) runs a connection test first and writes nothing if it fails. */
export async function saveAiSettings(c: Candidate & { model: string; verify?: boolean }): Promise<{ ok: true; keyChanged: boolean } | Failure> {
  const bad = modelIdError(c.model);
  if (bad) return fail("INVALID_MODEL", bad);
  if (c.provider && !AI_PROVIDER_IDS.includes(c.provider)) return fail("INVALID_PROVIDER", "Unknown provider.");
  const r = await resolveAccess(c);
  if (!r.ok) return r;
  const { provider, baseUrl, apiKey } = r.access;
  if (!apiKey) return needKey();
  if (c.verify !== false) {
    const t = await testConnection({ provider, baseUrl, apiKey, model: c.model });
    if (!t.ok) return fail(t.error.code, aiErrorMessage(t.error.code, hostOf(baseUrl), t.error.http_status), t.error.http_status);
  }
  await setConfigs([["AI_PROVIDER", provider], ["AI_MODEL", c.model], ...(r.access.keyGiven ? [["AI_API_KEY", apiKey] as const] : []), ...(provider === "custom" ? [["AI_BASE_URL", baseUrl] as const] : [])]);
  if (provider !== "custom") await clearConfig("AI_BASE_URL");
  return { ok: true, keyChanged: r.access.keyGiven };
}

/** Drop the values stored in the database (the environment values apply again). */
export async function clearAiSettings(): Promise<void> {
  for (const key of ["AI_PROVIDER", "AI_BASE_URL", "AI_MODEL", "AI_API_KEY"] as const) await clearConfig(key);
}
