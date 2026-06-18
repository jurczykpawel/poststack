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
  /** Legacy key names still honored on read (DB + env), in priority order after `key`. Lets a key be
   *  renamed without breaking existing deployments: getConfig reads them as a fallback, setConfig
   *  migrates them away. */
  aliases?: readonly string[];
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

  // Google / YouTube OAuth client (Google Cloud Console → Credentials → OAuth client).
  { key: "GOOGLE_CLIENT_ID", group: "Google / YouTube", label: "OAuth Client ID", secret: false, help: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID." },
  { key: "GOOGLE_CLIENT_SECRET", group: "Google / YouTube", label: "OAuth Client Secret", secret: true, help: "The client secret for the same Google OAuth client." },

  // AI rephrase — ANY OpenAI-compatible chat-completions endpoint (OpenAI, OpenRouter, Groq, Together,
  // DeepSeek, local Ollama, …). Names are provider-neutral; the legacy OPENAI_* / AI_REPHRASE_MODEL
  // names are still honored as aliases so existing configs keep working without a redeploy.
  { key: "AI_API_KEY", aliases: ["OPENAI_API_KEY"], group: "AI rephrasing (OpenAI-compatible)", label: "API Key", secret: true, help: "Bearer API key for your OpenAI-compatible provider. Leave unset to disable AI rephrasing. (Legacy name OPENAI_API_KEY still works.)" },
  { key: "AI_BASE_URL", aliases: ["OPENAI_BASE_URL"], group: "AI rephrasing (OpenAI-compatible)", label: "Base URL", secret: false, help: "Chat-completions base URL. Examples: OpenAI https://api.openai.com/v1 · OpenRouter https://openrouter.ai/api/v1 · Groq https://api.groq.com/openai/v1 · Ollama http://host:11434/v1. Defaults to OpenAI if unset." },
  { key: "AI_MODEL", aliases: ["AI_REPHRASE_MODEL"], group: "AI rephrasing (OpenAI-compatible)", label: "Model", secret: false, help: "Model name for your provider. Examples: gpt-4o-mini · anthropic/claude-3.5-haiku (OpenRouter) · llama-3.3-70b-versatile (Groq). Defaults to gpt-4o-mini." },

  // Integrations — outbound alert webhook + inbound ReelStack webhook.
  { key: "CHANNEL_ALERT_WEBHOOK_URL", group: "Integrations", label: "Alert Webhook URL", secret: false, help: "Outbound POST when a channel needs re-auth or nears expiry (the ungated self-host fallback)." },
  { key: "REELSTACK_WEBHOOK_SECRET", group: "Integrations", label: "ReelStack Webhook Secret", secret: true, help: "HMAC shared secret for the inbound ReelStack webhook (also requires REELSTACK_WEBHOOK_WORKSPACE_ID in env)." },

  // Security — ALTCHA proof-of-work HMAC key (enables CAPTCHA on login/register).
  { key: "ALTCHA_HMAC_KEY", group: "Security", label: "ALTCHA HMAC Key", secret: true, help: "Enables the proof-of-work CAPTCHA on auth endpoints. Unset = CAPTCHA skipped (dev). Generate a key with: openssl rand -hex 32" },

  // NOTE (CONFIG1): STORAGE_* is deferred (its client is a sync singleton needing a separate refactor).
  // New groups follow the same pattern: a registry entry here + swapping the consumer from `env.X` /
  // `process.env.X` to `await getConfig("X")` in an async context.
] as const;

export type ConfigKey = (typeof CONFIG_FIELDS)[number]["key"];

export const CONFIG_KEYS: ReadonlySet<string> = new Set(CONFIG_FIELDS.map((f) => f.key));

export function configField(key: string): ConfigField | undefined {
  return CONFIG_FIELDS.find((f) => f.key === key);
}
