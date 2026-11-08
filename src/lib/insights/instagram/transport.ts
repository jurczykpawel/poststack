import { GRAPH_API_BASE, IG_GRAPH_BASE, META_API_VERSION, IG_GRAPH_API_VERSION } from "@/lib/platforms/constants";
import type { InsightAccess, InsightBatch, InsightCredential, InsightFailure, InsightQuery, InsightsConnector } from "../types";
import { instagramCatalog, instagramRecipes } from "./catalog";
import { parseInsightJson } from "./json";
import { object, parseInstagramInsights } from "./parser";

function boundedNumber(value: unknown, max = 1e9): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^\d+(?:\.\d+)?$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : null;
}

export function readUsage(headers: Headers): InsightBatch["usage"] {
  let percent: number | null = null, regainAfterSeconds: number | null = null;
  for (const name of ["x-app-usage", "x-business-use-case-usage"]) {
    const text = headers.get(name);
    if (!text || text.length > 16384) continue;
    try {
      const walk = (item: unknown, depth: number) => {
        if (depth > 8 || !item || typeof item !== "object") return;
        const row = item as Record<string, unknown>;
        for (const key of ["call_count", "total_time", "total_cputime"]) {
          const value = boundedNumber(row[key], 10000);
          if (value !== null) percent = Math.max(percent ?? 0, value);
        }
        const regain = boundedNumber(row.estimated_time_to_regain_access, 525600);
        if (regain !== null) regainAfterSeconds = Math.max(regainAfterSeconds ?? 0, regain * 60);
        for (const child of Object.values(row)) walk(child, depth + 1);
      };
      walk(parseInsightJson(text), 0);
    } catch { /* Optional usage headers can be absent or unavailable. */ }
  }
  return { percent, regainAfterSeconds };
}

export function classifyInsightError(status: number, error: Record<string, unknown>, retryAfter: string | null): InsightFailure {
  const code = boundedNumber(error.code);
  const numericRetry = boundedNumber(retryAfter, 31536000);
  const retryDate = retryAfter && numericRetry === null ? Date.parse(retryAfter) : NaN;
  const retryAfterSeconds = numericRetry ?? (Number.isFinite(retryDate) ? Math.max(0, Math.ceil((retryDate - Date.now()) / 1000)) : null);
  if (code === 190 || code === 102 || code === 467) return { kind: "invalid_token", retryAfterSeconds };
  if (status === 429 || [4, 17, 32, 613, 80002].includes(code ?? -1)) return { kind: "rate_limited", retryAfterSeconds };
  if (status >= 500 || error.is_transient === true) return { kind: "transient", retryAfterSeconds };
  return { kind: "unknown", retryAfterSeconds };
}

function validateQuery(credential: InsightCredential, query: InsightQuery): void {
  const from = Date.parse(query.from), to = Date.parse(query.to);
  if (!["facebook", "instagram_business"].includes(credential.transport) || !credential.token || /[\r\n]/.test(credential.token) || !/^[a-zA-Z0-9_-]{1,128}$/.test(credential.accountKey) ||
      query.level !== "account" || query.subjectKey !== credential.accountKey || query.grain !== "day" ||
      !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 90 * 86400000 || from % 1000 || to % 1000 ||
      !query.metrics.length || new Set(query.metrics).size !== query.metrics.length ||
      query.metrics.some((key) => !instagramRecipes.some((recipe) => recipe.key === key && recipe.grain === query.grain))) {
    throw { kind: "unknown", retryAfterSeconds: null } satisfies InsightFailure;
  }
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > 256 * 1024) { await response.body?.cancel(); throw new Error("Insights response too large"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing insights body");
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw new Error("Insights response too large"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

function withUsage(failure: InsightFailure, usage: InsightBatch["usage"]): InsightFailure {
  const percent=usage.percent ?? 0;
  return {...failure,retryAfterSeconds:Math.max(failure.retryAfterSeconds ?? 0,usage.regainAfterSeconds ?? 0,percent>=90?3600:percent>=80?900:0)||null};
}

async function fetchInsights(credential: InsightCredential, query: InsightQuery): Promise<InsightBatch> {
  validateQuery(credential, query);
  const base = credential.transport === "facebook" ? GRAPH_API_BASE : IG_GRAPH_BASE;
  const url = new URL(`${base}/${encodeURIComponent(credential.accountKey)}/insights`);
  const queryParams = { metric: query.metrics.join(","), period: "day", metric_type: "time_series", since: String(Date.parse(query.from) / 1000), until: String(Date.parse(query.to) / 1000 - 1) };
  url.search = new URLSearchParams(queryParams).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let responseUsage: InsightBatch["usage"] = {percent:null,regainAfterSeconds:null};
  try {
    const response = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Authorization: `Bearer ${credential.token}` } });
    const usage = readUsage(response.headers);
    responseUsage = usage;
    const text = await readBody(response, controller.signal);
    let body: Record<string, unknown>;
    try { body = object(parseInsightJson(text)); }
    catch {
      if (!response.ok) throw withUsage(classifyInsightError(response.status, {}, response.headers.get("retry-after")),usage);
      throw new Error("Invalid insights response");
    }
    if (!response.ok || body.error) {
      const failure = classifyInsightError(response.status, body.error ? object(body.error) : {}, response.headers.get("retry-after"));
      throw withUsage(failure,usage);
    }
    const fetchedAt = new Date().toISOString();
    const observations = parseInstagramInsights(body, query, {
      platform: "instagram", level: query.level, subjectKey: query.subjectKey, grain: query.grain, period: "day", metricType: "time_series",
      windowStart: query.from, windowEnd: query.to, snapshotDay: query.from.slice(0, 10), fetchedAt, providerDay: null,
      boundaryBasis: "provider_end_time", queryParams, transport: credential.transport,
      apiVersion: credential.transport === "facebook" ? META_API_VERSION : IG_GRAPH_API_VERSION,
      definitionVersion: instagramCatalog[0].definitionVersion, coverageBasis: instagramCatalog[0].coverageBasis,
    });
    return { observations, usage };
  } catch (error) {
    if (error && typeof error === "object" && "kind" in error) throw withUsage(error as InsightFailure,responseUsage);
    throw withUsage({ kind: controller.signal.aborted || error instanceof TypeError ? "transient" : "unknown", retryAfterSeconds: null },responseUsage);
  } finally { clearTimeout(timer); }
}

export const instagramInsightsConnector: InsightsConnector = {
  source: "meta_instagram",
  requiredPermissions: (transport) => transport === "instagram_business"
    ? ["instagram_business_basic", "instagram_business_manage_insights"] : ["instagram_basic", "instagram_manage_insights", "pages_read_engagement"],
  catalog: () => instagramCatalog,
  fetch: fetchInsights,
  async access(credential): Promise<InsightAccess> {
    const requiredPermissions = [...instagramInsightsConnector.requiredPermissions!(credential.transport)];
    const access: InsightAccess = { state: "unknown", transport: credential.transport, credentialRevision: credential.revision, requiredPermissions, missingPermissions: [], checkedAt: new Date().toISOString() };
    const to = new Date(); to.setUTCHours(0, 0, 0, 0);
    try {
      await fetchInsights(credential, { level: "account", subjectKey: credential.accountKey, from: new Date(to.getTime() - 86400000).toISOString(), to: to.toISOString(), metrics: ["reach"], grain: "day" });
      return { ...access, state: "ready" };
    } catch (error) {
      const kind = (error as InsightFailure).kind;
      if (kind === "transient" || kind === "rate_limited") throw error;
      return { ...access, state: kind === "invalid_token" ? "needs_reauth" : kind === "missing_permission" ? "missing_permission" : "unknown" };
    }
  },
  async consentTransport(ref) {
    const { resolveInsightCredential } = await import("../credentials");
    return (await resolveInsightCredential(ref, null))?.transport ?? null;
  },
};
