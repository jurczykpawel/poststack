import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { aiProviders, instanceSettings } from "@/db/schema";
import { db } from "../db";
import { decryptString, encryptString } from "../crypto";
import { ApiError } from "../api/response";
import { configField } from "../settings/registry";
import { invalidateConfigCache } from "../settings/config";
import { AI_PROVIDER_IDS, baseUrlError, modelIdError, resolveBaseUrl, type ProviderCall } from "./providers";
import { listModels, testConnection } from "./models";

export const providerInput = z.object({
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  api_key: z.string().min(1).max(500).regex(/^\S+$/).optional(),
  base_url: z.string().max(300).optional(),
  model: z.string().min(1).max(200).optional(),
}).strict();
export type ProviderInput = z.infer<typeof providerInput>;
export type ProviderRow = typeof aiProviders.$inferSelect;
export type ProviderStatus = ProviderRow["last_test_status"];
export type ProviderScope = string | null;
const where = (scope: ProviderScope) => scope ? eq(aiProviders.workspace_id, scope) : isNull(aiProviders.workspace_id);

const context = (scope: ProviderScope, id: string) => [scope ? `ws:${scope}` : "instance", "ai_providers.api_key_encrypted", id] as const;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const locked = <T>(scope: ProviderScope, fn: (tx: Tx) => Promise<T>) => db.transaction(async tx => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ai-providers:${scope ?? "instance"}`}))`);
  return fn(tx);
});
const selection = (tx: Tx | typeof db, scope: ProviderScope) => tx.select().from(aiProviders).where(where(scope)).orderBy(asc(aiProviders.position));
export async function listProviders(scope: ProviderScope) {
  const rows = await selection(db, scope);
  const answering = [...rows].filter(r => r.last_success_at).sort((a, b) => b.last_success_at!.getTime() - a.last_success_at!.getTime())[0]?.id;
  return rows.map(r => ({ id: r.id, position: r.position, provider: r.provider, base_url: r.base_url, model: r.model, api_key_hint: r.api_key_hint, last_test_status: r.last_test_status, last_test_at: r.last_test_at, answering_now: r.id === answering }));
}
async function rowFor(scope: ProviderScope, id: string) {
  const [row] = await db.select().from(aiProviders).where(and(where(scope), eq(aiProviders.id, id)));
  if (!row) throw new ApiError("not_found", "Provider not found", 404);
  return row;
}
export async function providerAccess(scope: ProviderScope, input: ProviderInput, id?: string): Promise<ProviderCall> {
  const old = id ? await rowFor(scope, id) : undefined;
  const provider = input.provider ?? old?.provider;
  const model = input.model ?? old?.model ?? "";
  if (!provider || modelIdError(model)) throw new ApiError("validation_error", "Choose a provider and valid model", 422);
  if (provider !== "custom" && input.base_url) throw new ApiError("validation_error", "Base URL is only available for custom providers", 422);
  const baseUrl = resolveBaseUrl(provider, input.base_url ?? (old?.provider === "custom" ? old.base_url : ""));
  if (!baseUrl || baseUrlError(baseUrl)) throw new ApiError("validation_error", "Enter a valid Base URL", 422);
  const apiKey = input.api_key ?? (old && provider === old.provider && baseUrl === old.base_url ? decryptString(old.api_key_encrypted, context(scope, old.id)) : "");
  if (!apiKey) throw new ApiError("validation_error", "Enter the API key for this provider and Base URL", 422);
  return { provider, baseUrl, apiKey, model };
}
async function renumber(tx: Tx, scope: ProviderScope, ids: string[]) {
  await tx.update(aiProviders).set({ position: sql`${aiProviders.position} + ${ids.length + 1}` }).where(where(scope));
  for (const [i, id] of ids.entries()) await tx.update(aiProviders).set({ position: i + 1 }).where(and(where(scope), eq(aiProviders.id, id)));
}
export async function reorderProviders(scope: ProviderScope, ids: string[]) {
  await locked(scope, async tx => {
    const current = await selection(tx, scope);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || current.some(r => !ids.includes(r.id))) throw new ApiError("conflict", "The provider list changed. Reload and try again.", 409);
    await renumber(tx, scope, ids);
  });
  return listProviders(scope);
}
export async function removeProvider(scope: ProviderScope, id: string) {
  await locked(scope, async tx => {
    const result = await tx.delete(aiProviders).where(and(where(scope), eq(aiProviders.id, id))).returning({ id: aiProviders.id });
    if (!result.length) throw new ApiError("not_found", "Provider not found", 404);
    await renumber(tx, scope, (await selection(tx, scope)).map(r => r.id));
  });
}
export async function probeProvider(scope: ProviderScope, input: ProviderInput, id?: string) {
  const result = await testConnection(await providerAccess(scope, input, id));
  if (id) await db.update(aiProviders).set({ last_test_status: result.ok ? "ok" : result.error.code === "no_models_endpoint" ? "bad_response" : result.error.code, last_test_at: new Date() }).where(and(where(scope), eq(aiProviders.id, id)));
  return result;
}
export async function providerModels(scope: ProviderScope, input: ProviderInput, id?: string, options: { refresh?: boolean; all?: boolean } = {}) {
  return listModels(await providerAccess(scope, { ...input, model: input.model ?? "model-list" }, id), options);
}
async function prepareProvider(scope: ProviderScope, input: ProviderInput, id?: string) {
  const access = await providerAccess(scope, input, id);
  const result = await testConnection(access);
  if (!result.ok) throw Object.assign(new ApiError(result.error.code, "Connection test failed. Check the provider, key and model.", 422), { httpStatus: result.error.http_status });
  const rowId = id ?? randomUUID();
  const api_key_encrypted = encryptString(access.apiKey);
  return { id: rowId, provider: access.provider, base_url: access.baseUrl, model: access.model, api_key_encrypted, api_key_hint: access.apiKey.length > 4 ? access.apiKey.slice(-4) : "", last_test_status: "ok" as const, last_test_at: new Date(), last_success_at: null, updated_at: new Date() };
}
export async function saveProvider(scope: ProviderScope, input: ProviderInput, id?: string, creator?: string) {
  const values = await prepareProvider(scope, input, id);
  await locked(scope, async tx => {
    if (id) {
      const updated = await tx.update(aiProviders).set(values).where(and(where(scope), eq(aiProviders.id, id))).returning({ id: aiProviders.id });
      if (!updated.length) throw new ApiError("not_found", "Provider not found", 404);
    } else await tx.insert(aiProviders).values({ ...values, workspace_id: scope, position: (await selection(tx, scope)).length + 1, created_by_user_id: creator });
  });
  return (await listProviders(scope)).find(r => r.id === values.id)!;
}
export async function recordProviderOutcome(scope: ProviderScope, id: string, status: ProviderStatus) {
  await db.update(aiProviders).set({ last_test_status: status, last_test_at: new Date(), ...(status === "ok" ? { last_success_at: new Date() } : {}) }).where(and(where(scope), eq(aiProviders.id, id)));
}
export async function migrateInstanceProviders() {
  const migrated = await locked(null, async tx => {
    const marker = "AI_PROVIDERS_MIGRATED";
    if ((await tx.select().from(instanceSettings).where(eq(instanceSettings.key, marker))).length) return false;
    const keys = ["AI_API_KEY", "AI_MODEL", "AI_PROVIDER", "AI_BASE_URL", "AI_FALLBACKS"].flatMap(key => [key, ...(configField(key)?.aliases ?? [])]);
    const legacy = await tx.select().from(instanceSettings).where(inArray(instanceSettings.key, keys));
    if (legacy.length && !(await selection(tx, null)).length) {
      const { parseFallbacks } = await import("./client");
      const { providerFromBaseUrl } = await import("./providers");
      const values = new Map(legacy.map(r => [r.key, decryptString(r.value_encrypted, ["instance", "instance_settings.value_encrypted", r.key])]));
      const read = (key: string) => {
        const names = [key, ...(configField(key)?.aliases ?? [])];
        return names.map(name => values.get(name)).find(Boolean) || names.map(name => process.env[name]).find(Boolean) || "";
      };
      const stored = read("AI_PROVIDER"), provider = AI_PROVIDER_IDS.includes(stored as typeof AI_PROVIDER_IDS[number]) ? stored as typeof AI_PROVIDER_IDS[number] : providerFromBaseUrl(read("AI_BASE_URL"));
      const primary = { provider, apiKey: read("AI_API_KEY"), baseUrl: resolveBaseUrl(provider, read("AI_BASE_URL")), model: read("AI_MODEL") || "gpt-4o-mini" };
      const chain = [...(primary.apiKey ? [primary] : []), ...parseFallbacks(read("AI_FALLBACKS"))];
      for (const [i, c] of chain.entries()) {
        const id = randomUUID(), provider = "provider" in c && c.provider ? c.provider : providerFromBaseUrl(c.baseUrl);
        await tx.insert(aiProviders).values({ id, position: i + 1, provider, base_url: resolveBaseUrl(provider, c.baseUrl), model: c.model, api_key_hint: c.apiKey.length > 4 ? c.apiKey.slice(-4) : "", api_key_encrypted: encryptString(c.apiKey) });
      }
      await tx.delete(instanceSettings).where(inArray(instanceSettings.key, keys));
    }
    await tx.insert(instanceSettings).values({ key: marker, value_encrypted: encryptString("1") });
    return true;
  });
  if (migrated) invalidateConfigCache();
}
export async function storedProviderChain() {
  const scope = null;
  await migrateInstanceProviders();
  const rows = await selection(db, scope);
  if (!rows.length) return null;
  return rows.map(r => ({ id: r.id, scope, provider: r.provider, baseUrl: r.base_url, model: r.model, apiKey: decryptString(r.api_key_encrypted, context(scope, r.id)) }));
}

export async function replaceProviders(scope: ProviderScope, entries: (ProviderInput & { id?: string })[], creator?: string) {
  const before = await selection(db, scope);
  const ids = entries.flatMap(r => r.id ? [r.id] : []);
  if (new Set(ids).size !== ids.length || ids.some(id => !before.some(r => r.id === id))) throw new ApiError("conflict", "Provider list changed", 409);
  const prepared: Awaited<ReturnType<typeof prepareProvider>>[] = [];
  for (const { id, ...input } of entries) prepared.push(await prepareProvider(scope, input, id));
  const version = (rows: ProviderRow[]) => JSON.stringify(rows.map(r => [r.id, r.position, r.api_key_encrypted, r.updated_at]));
  await locked(scope, async tx => {
    if (version(await selection(tx, scope)) !== version(before)) throw new ApiError("conflict", "Provider list changed", 409);
    await tx.delete(aiProviders).where(where(scope));
    if (prepared.length) await tx.insert(aiProviders).values(prepared.map((r, i) => ({ ...r, workspace_id: scope, position: i + 1, created_by_user_id: before.find(old => old.id === r.id)?.created_by_user_id ?? creator })));
  });
  return listProviders(scope);
}

export async function savedInstanceConfig() {
  const [row] = await selection(db, null).limit(1);
  return row ? { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey: decryptString(row.api_key_encrypted, context(null, row.id)) } : null;
}
export async function hasStoredProviders(): Promise<boolean | null> {
  const scope = null;
  await migrateInstanceProviders();
  const [row] = await db.select({ id: aiProviders.id }).from(aiProviders).where(where(scope)).limit(1);
  return row ? true : null;
}
