import { createHash } from "node:crypto";
import { aiFetch } from "./net";
import { chatRequest, chatFinishedByLength, isChatModel, isReasoningModel, modelsRequest, parseChatText, parseModels, preset, type AiModel, type AiProviderId, type ProviderCall } from "./providers";

// AIPROVIDER1: the provider model list (cached in memory) and the "check connection" probe. Errors carry
// only a code and the HTTP status — never the provider's response body (no key echo, no network oracle).

export type AiErrorCode = "invalid_key" | "model_not_found" | "rate_limited" | "no_credits" | "timeout" | "unreachable" | "blocked_target" | "no_models_endpoint" | "bad_response";

export class AiError extends Error {
  constructor(public code: AiErrorCode, public httpStatus?: number) {
    super(code);
  }
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
export interface ProviderAccess { provider: AiProviderId; baseUrl: string; apiKey: string }

const listFetch: FetchImpl = (url, init) => aiFetch(url, init, { deadlineMs: 8_000, maxResponseBytes: 2_000_000 });
const testFetch: FetchImpl = (url, init) => aiFetch(url, init, { deadlineMs: 20_000, maxResponseBytes: 65_536 });

/** Map a thrown network/SSRF error to a code. */
function fromThrown(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const m = e instanceof Error ? e.message : String(e);
  if (/refused \w+ address/.test(m)) return new AiError("blocked_target");
  if (/timed out|deadline|aborted|timeout/i.test(m)) return new AiError("timeout");
  if (/too large/.test(m)) return new AiError("bad_response");
  return new AiError("unreachable");
}

/** OpenAI-style 429 bodies say whether the account is out of credits rather than throttled. */
const NO_CREDITS = /insufficient_quota|credit_balance|billing/i;

function fromStatus(status: number, notFound: AiErrorCode, body = ""): AiError {
  if (status === 401 || status === 403) return new AiError("invalid_key", status);
  if (status === 404) return new AiError(notFound, status);
  if (status === 429) return new AiError(NO_CREDITS.test(body) ? "no_credits" : "rate_limited", status);
  return new AiError("bad_response", status);
}

const CACHE_TTL_MS = 24 * 3600_000;
const CACHE_MAX = 8;
const cache = new Map<string, { at: number; models: AiModel[] }>();
export const clearModelCache = () => cache.clear();

export interface ModelList { models: AiModel[]; fetched_at: string; cached: boolean; filtered_out: number }

async function fetchPages(a: ProviderAccess, fetchImpl: FetchImpl): Promise<AiModel[]> {
  const req = modelsRequest(a.provider, a.baseUrl, a.apiKey);
  const models: AiModel[] = [];
  let url = req.url;
  for (let page = 0; page < 3; page++) {
    let res: Response;
    try { res = await fetchImpl(url, { method: "GET", headers: req.headers, redirect: "error" }); } catch (e) { throw fromThrown(e); }
    if (!res.ok) throw fromStatus(res.status, a.provider === "custom" ? "no_models_endpoint" : "bad_response", await res.text().catch(() => ""));
    const json = (await res.json().catch(() => null)) as { data?: unknown; has_more?: boolean; last_id?: string } | null;
    if (!json || !Array.isArray(json.data)) throw new AiError("bad_response", res.status);
    models.push(...parseModels(a.provider, json));
    if (a.provider !== "anthropic" || !json.has_more || !json.last_id) break;
    url = `${req.url}&after_id=${encodeURIComponent(json.last_id)}`;
  }
  return models;
}

/** The model list of a provider: cached 24 h per (provider, URL, key) — `refresh` bypasses, `all` skips the non-chat filter. */
export async function listModels(
  a: ProviderAccess,
  o: { refresh?: boolean; all?: boolean; fetchImpl?: FetchImpl; now?: () => number } = {},
): Promise<ModelList> {
  const now = (o.now ?? Date.now)();
  if (!a.apiKey && preset(a.provider).modelsNeedKey) throw new AiError("invalid_key");
  const key = createHash("sha256").update(`${a.provider}|${a.baseUrl}|${a.apiKey}`).digest("hex");
  let entry = cache.get(key);
  const hit = !!entry && !o.refresh && now - entry.at < CACHE_TTL_MS;
  if (!hit) {
    entry = { at: now, models: await fetchPages(a, o.fetchImpl ?? listFetch) };
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  const models = o.all ? entry!.models : entry!.models.filter((m) => isChatModel(m.id));
  return { models, fetched_at: new Date(entry!.at).toISOString(), cached: hit, filtered_out: entry!.models.length - models.length };
}

export type TestResult =
  | { ok: true; latency_ms: number; model: string; truncated?: true }
  | { ok: false; error: { code: AiErrorCode; http_status?: number; message?: string } };

/** One minimal chat request to the chosen model. Never throws; a spent token budget (reasoning) still counts as working. */
export async function testConnection(c: ProviderCall, o: { fetchImpl?: FetchImpl } = {}): Promise<TestResult> {
  const started = Date.now();
  try {
    const req = chatRequest(c, { system: "Reply with OK.", user: "Reply with OK.", maxTokens: isReasoningModel(c.model) ? 64 : 16, temperature: 0 });
    const res = await (o.fetchImpl ?? testFetch)(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), redirect: "error" }).catch((e) => { throw fromThrown(e); });
    if (!res.ok) throw fromStatus(res.status, "model_not_found", await res.text().catch(() => ""));
    const json = await res.json().catch(() => null);
    if (parseChatText(c.provider, json)) return { ok: true, latency_ms: Date.now() - started, model: c.model };
    if (chatFinishedByLength(c.provider, json)) return { ok: true, latency_ms: Date.now() - started, model: c.model, truncated: true };
    throw new AiError("bad_response", res.status);
  } catch (e) {
    const err = fromThrown(e);
    return { ok: false, error: err.httpStatus === undefined ? { code: err.code } : { code: err.code, http_status: err.httpStatus } };
  }
}
