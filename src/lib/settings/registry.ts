// CONFIG1: the registry of operator-configurable integration credentials. Each entry maps a settings
// key (identical to its env-var name) to its UI grouping + metadata. The resolver (config.ts) prefers
// a DB-stored value over the matching env var, so these can be set from the dashboard instead of .env.
//
// NOT included here (stay env-only): bootstrap/infra (DATABASE_URL, ENCRYPTION_KEY, JWT_SECRET,
// CRON_SECRET, APP_URL, TRUSTED_PROXY, REGISTRATION_ENABLED) and the license token (managed on its own
// /settings License panel). STORAGE_* is intentionally deferred (its client is a sync singleton — a
// separate refactor).

export interface ConfigField {
  /** Settings key — identical to the env var name it overrides. */
  key: string;
  /** UI group heading. */
  group: string;
  /** Human label. */
  label: string;
  /** A secret (masked in UI, never echoed back) vs a plain config value (shown). */
  secret: boolean;
  help?: string;
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  // Meta (Facebook + Instagram) app — the primary self-host credential set.
  { key: "META_APP_ID", group: "Meta (Facebook & Instagram)", label: "App ID", secret: false, help: "From your Meta app → Settings → Basic." },
  { key: "META_APP_SECRET", group: "Meta (Facebook & Instagram)", label: "App Secret", secret: true, help: "Meta app → Settings → Basic → App Secret." },
  { key: "META_WEBHOOK_VERIFY_TOKEN", group: "Meta (Facebook & Instagram)", label: "Webhook Verify Token", secret: true, help: "Any string you choose; paste the same value into the Meta webhook config." },

  // NOTE (CONFIG1): more credential groups (Google/YouTube OAuth, AI rephrase OpenAI key, channel-alert
  // & ReelStack webhooks, ALTCHA) are planned on this same foundation — see priv/tasks/CONFIG1. They're
  // added one group at a time: a registry entry here + swapping their consumer from `env.X` to
  // `getConfig("X")`. STORAGE_* is deferred (its client is a sync singleton needing a separate refactor).
] as const;

export type ConfigKey = (typeof CONFIG_FIELDS)[number]["key"];

export const CONFIG_KEYS: ReadonlySet<string> = new Set(CONFIG_FIELDS.map((f) => f.key));

export function configField(key: string): ConfigField | undefined {
  return CONFIG_FIELDS.find((f) => f.key === key);
}
