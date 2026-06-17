import { z } from "zod";
import { isSafeAlertWebhookUrl } from "@/lib/notifications/webhook-url";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRY: z.string().default("7d"),
  // Open self-registration. Default closed: the first user (empty instance) can
  // always register to bootstrap; after that, set "true" to allow more.
  REGISTRATION_ENABLED: z.string().default("false"),

  // At-rest encryption secret. Any passphrase >= 32 chars; sha256-derived to a 32-byte AES key
  // (see crypto.ts requireEncryptionKey — the single runtime guard). Validated here too so a
  // missing/short key fails at boot, not on the first encrypt (e.g. a channel connect).
  ENCRYPTION_KEY: z
    .string()
    .min(32, "ENCRYPTION_KEY must be at least 32 characters. Generate: openssl rand -base64 32"),

  // App
  APP_URL: z.string().url(),

  // Reverse-proxy trust. "" (default) = only trust X-Real-IP / the rightmost
  // X-Forwarded-For hop (the proxy's own value). Set "cloudflare" ONLY when
  // actually behind Cloudflare, to trust CF-Connecting-IP.
  TRUSTED_PROXY: z.string().default(""),

  // Object storage (S3-compatible: Backblaze B2 / R2 / MinIO). With STORAGE_ENDPOINT unset, media
  // falls back to an in-memory store (dev/tests). STORAGE_PUBLIC_BASE_URL must serve the bucket
  // publicly so platforms (Meta `url=` publish) can pull the asset. STORAGE_PUBLIC_BUCKET names the
  // shared content-addressed bucket (e.g. `tsa-media-public`) — same naming as ReelStack so a reel
  // it rendered can be linked here by reference without re-upload.
  STORAGE_ENDPOINT: z.string().default(""),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_PUBLIC_BUCKET: z.string().default(""),
  STORAGE_ACCESS_KEY_ID: z.string().default(""),
  STORAGE_SECRET_ACCESS_KEY: z.string().default(""),
  STORAGE_PUBLIC_BASE_URL: z.string().default(""),

  // ReelStack reel.completed inbound webhook (optional, OFF by default). BOTH must be set to enable
  // POST /integrations/reelstack/webhook: the HMAC shared secret (must equal ReelStack's
  // WEBHOOK_CALLBACK_SECRET) and the workspace a completed reel is auto-registered into (this app is
  // multi-tenant, so a global integration must name its target tenant). Either unset ⇒ endpoint 404s.
  REELSTACK_WEBHOOK_SECRET: z.string().default(""),
  REELSTACK_WEBHOOK_WORKSPACE_ID: z.string().default(""),

  // Altcha CAPTCHA (optional -- login/register skip verification without key)
  ALTCHA_HMAC_KEY: z.string().default(""),

  // AI rephrase (optional -- rule type "ai_rephrase" falls back to original text without key).
  // Declared here (not read ad-hoc from process.env) so the model + endpoint are a single typed
  // source with defaults, and a malformed base URL fails at boot instead of silently.
  OPENAI_API_KEY: z.string().default(""),
  AI_REPHRASE_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  // Per-workspace LLM-call budget over a rolling 24h window. An ai_rephrase rule on a broad trigger
  // (welcome/default) fires one paid LLM call per inbound across ALL contacts, so an inbound flood
  // would otherwise run up an unbounded OpenAI bill; over this cap rephrase fails soft to the
  // operator's base text. Generous default for normal use; tune down for a tight budget.
  AI_REPHRASE_DAILY_LIMIT: z.coerce.number().int().positive().default(1000),

  // Meta (optional — app starts without them, OAuth won't work until configured)
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(""),

  // Google / YouTube (optional — needed only to connect a YouTube channel for comment automation)
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  // Optional outbound webhook fired when a channel needs re-auth. Validated up front so a
  // private/link-local target (e.g. the cloud metadata endpoint) is rejected at boot rather
  // than fetched at runtime. https anywhere, or http to a hostname / loopback; a
  // private-IP *literal* is refused.
  CHANNEL_ALERT_WEBHOOK_URL: z
    .string()
    .refine(isSafeAlertWebhookUrl, "must be an http(s) URL to a public or loopback host (no private/link-local IP literals)")
    .optional(),

  // License gating (all optional — no license = free tier, full free features).
  // The operator's Sellf license token. Bootstrap/headless default; the panel can
  // override it (DB takes precedence over this env var).
  LICENSE_KEY: z.string().default(""),
  // Seller-scoped JWKS endpoint (TSA seller baked into the URL — this is what binds
  // tokens to the seller; claims carry no seller field).
  LICENSE_JWKS_URL: z
    .string()
    .url()
    .default("https://sellf.techskills.academy/api/licenses/jwks?seller=83789f79-bdd7-4918-af1f-e56325fa5070"),
  // Product slug(s) the token must match (claims.product) — guards against another
  // product's token from the same seller unlocking PostStack. Comma-separated allowlist:
  // a single install can accept several products (e.g. annual + lifetime PRO variants and
  // the business tier), each a distinct Sellf product, all valid here.
  LICENSE_PRODUCT_SLUG: z.string().default("poststack"),
  // Seller-scoped revocation list (CRL). Licenses verify offline, so this is how a refunded /
  // revoked token is turned off: the gate refuses a token whose `order` claim is on the list.
  // Fails OPEN (a fetch outage never locks out a paying customer). Empty = revocation disabled.
  LICENSE_REVOCATION_URL: z
    .string()
    .default("https://sellf.techskills.academy/api/licenses/revoked?seller=83789f79-bdd7-4918-af1f-e56325fa5070"),
  // Pinned JWKS snapshot (JSON `{ keys: [...] }`) — durable fallback used only when
  // the live endpoint is unreachable AND nothing is cached (public-key material).
  SELLF_JWKS_FALLBACK: z.string().default(""),
  // Where the "requires PRO" UI sends operators to buy a license.
  LICENSE_UPGRADE_URL: z.string().url().default("https://sellf.techskills.academy/p/poststack"),
  // Optional. The instance's public domain for per-domain license binding. A license token may
  // carry a `domain` claim binding it to one buyer's domain (and its subdomains); it is honoured
  // only when THIS host falls under that domain. Empty → derived from APP_URL's host. Set this
  // explicitly when APP_URL is an internal/proxy URL that differs from the public domain the
  // license was issued for. Unbound (no domain claim) tokens ignore this entirely.
  LICENSE_DOMAIN: z.string().default(""),

  // Cron
  CRON_SECRET: z.string().min(32),

  // Runtime
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error(
      "Invalid environment variables:\n",
      parsed.error.flatten().fieldErrors
    );
    throw new Error("Invalid environment variables. Check your .env file.");
  }

  // Surface a clear startup signal for security-relevant settings that are silently lax in
  // production: an unset ALTCHA_HMAC_KEY skips CAPTCHA on auth endpoints, and an unset
  // TRUSTED_PROXY collapses per-IP rate limiting to a single bucket. Documented in the README,
  // but a warning means a misconfigured deploy isn't quietly unprotected.
  if (parsed.data.NODE_ENV === "production") {
    if (!parsed.data.ALTCHA_HMAC_KEY) {
      console.warn("[env] ALTCHA_HMAC_KEY is unset in production — CAPTCHA verification on login/register is SKIPPED.");
    }
    if (!parsed.data.TRUSTED_PROXY) {
      console.warn("[env] TRUSTED_PROXY is unset in production — per-IP rate limiting may collapse to one bucket if behind a proxy.");
    }
  }

  return parsed.data;
}

export const env = loadEnv();
