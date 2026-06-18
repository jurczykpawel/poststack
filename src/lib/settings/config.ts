// CONFIG1: resolve operator-configurable integration credentials, preferring a DB-stored (encrypted)
// value over the matching env var. So an operator can paste their Meta App ID/Secret etc. into the
// dashboard instead of editing .env — and the value takes effect without a redeploy.
//
// Values are encrypted at rest with the instance ENCRYPTION_KEY (crypto.ts). The DB read is cached
// (short TTL + invalidate-on-write) so hot paths like webhook-signature verification don't hit the DB
// per request.

import { inArray } from "drizzle-orm";
import { instanceSettings } from "@/db/schema";
import { encryptString, decryptString } from "@/lib/crypto";
import { CONFIG_KEYS, CONFIG_FIELDS, configField, type ConfigKey } from "./registry";

/** A key plus its legacy aliases, in read-priority order (canonical first). */
function keyWithAliases(key: string): string[] {
  return [key, ...(configField(key)?.aliases ?? [])];
}

// Lazy db import: `@/lib/db` throws at module load when DATABASE_URL is unset (pure unit tests). By
// importing it only inside the functions, this module stays import-safe — a config read without a DB
// just falls back to env vars (see loadAll's catch).
async function getDb() {
  return (await import("@/lib/db")).db;
}

const CACHE_TTL_MS = 30_000;
let cache: { values: Map<string, string>; at: number } | null = null;

/** Drop the cache (after a write, or in tests). */
export function invalidateConfigCache(): void {
  cache = null;
}

/** Load + decrypt all stored settings (cached). A row that fails to decrypt is skipped (treated as
 *  unset) rather than throwing — a single bad/rotated value must not break every config read. */
async function loadAll(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const values = new Map<string, string>();
  try {
    const rows = await (await getDb()).select().from(instanceSettings);
    for (const r of rows) {
      try {
        values.set(r.key, decryptString(r.value_encrypted));
      } catch {
        /* undecryptable (wrong/rotated key) → treat as unset */
      }
    }
  } catch {
    // DB unreachable / table missing (e.g. pre-migration, or a unit test with no DB) → every key
    // simply falls back to its env var. Don't cache a failed read, so it retries next time.
    return values;
  }
  cache = { values, at: Date.now() };
  return values;
}

// Env fallback reads process.env directly (not the validated `@/lib/env` object) so importing this
// module never triggers env validation — keeps it safe to import in pure-unit tests / pre-boot. The
// registered keys all default to "" in the schema, so this is equivalent for them.
function envValue(key: string): string {
  const v = process.env[key];
  return typeof v === "string" ? v : "";
}

/**
 * Resolve a configurable key: a non-empty DB value wins; otherwise fall back to the env var. So
 * existing env-based deployments keep working unchanged, and a dashboard-set value overrides.
 */
export async function getConfig(key: ConfigKey): Promise<string> {
  const stored = await loadAll();
  const keys = keyWithAliases(key);
  // DB value (canonical, then any legacy alias) wins…
  for (const k of keys) {
    const v = stored.get(k);
    if (v !== undefined && v !== "") return v;
  }
  // …otherwise fall back to the env var (canonical, then alias).
  for (const k of keys) {
    const v = envValue(k);
    if (v) return v;
  }
  return "";
}

/** Store (encrypted) a settings value, overriding the env var. Empty string clears it (→ env fallback). */
export async function setConfig(key: ConfigKey, value: string): Promise<void> {
  if (!CONFIG_KEYS.has(key)) throw new Error(`unknown config key: ${key}`);
  if (value === "") {
    await clearConfig(key);
    return;
  }
  const value_encrypted = encryptString(value);
  const dbc = await getDb();
  await dbc.insert(instanceSettings)
    .values({ key, value_encrypted, updated_at: new Date() })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value_encrypted, updated_at: new Date() } });
  // Migrate away any legacy alias rows so they can't resurface on a later read/clear of the canonical key.
  const aliases = configField(key)?.aliases ?? [];
  if (aliases.length > 0) await dbc.delete(instanceSettings).where(inArray(instanceSettings.key, [...aliases]));
  invalidateConfigCache();
}

/** Remove a stored value (and any legacy alias rows) → the key falls back to its env var. */
export async function clearConfig(key: ConfigKey): Promise<void> {
  await (await getDb()).delete(instanceSettings).where(inArray(instanceSettings.key, keyWithAliases(key)));
  invalidateConfigCache();
}

export type ConfigSource = "db" | "env" | "unset";
export interface ConfigStatus {
  key: string;
  group: string;
  label: string;
  secret: boolean;
  help?: string;
  source: ConfigSource;
  /** Safe-to-display value: real value for non-secret config; a masked stub for secrets; "" if unset.
   *  Secret plaintext is NEVER returned. */
  preview: string;
}

/** Per-field status for the Settings UI. Never returns a secret's plaintext — only whether it's set
 *  (db/env) and a masked preview; non-secret values are shown in full. */
export async function configStatus(): Promise<ConfigStatus[]> {
  const stored = await loadAll();
  return CONFIG_FIELDS.map((f) => {
    const keys = keyWithAliases(f.key);
    // Resolve DB + env across the canonical key and its legacy aliases (canonical wins).
    const dbv = keys.map((k) => stored.get(k)).find((v) => v !== undefined && v !== "");
    const hasDb = dbv !== undefined && dbv !== "";
    const envv = keys.map((k) => envValue(k)).find((v) => v) ?? "";
    const source: ConfigSource = hasDb ? "db" : envv ? "env" : "unset";
    const resolved = hasDb ? dbv! : envv;
    let preview = "";
    if (source !== "unset") preview = f.secret ? "•••••• (set)" : resolved;
    return { key: f.key, group: f.group, label: f.label, secret: f.secret, help: f.help, source, preview };
  });
}
