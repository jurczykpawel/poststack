// Shared e2e constants + the server env block. Kept in one module so the Playwright config
// (webServer.env) and global-setup (DB url) read the same values.
import { jwksFallbackJson } from "./fixtures/keys";

export const E2E_PORT = 3099;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
// Dedicated e2e database on the shared test Postgres (:5433) — isolated from the integration gate's
// `test` DB. global-setup creates it if missing.
export const E2E_DATABASE_URL = "postgres://test:test@localhost:5433/unify_e2e";
// Connect-to-create target: the always-present `test` DB on the same server.
export const E2E_ADMIN_DATABASE_URL = "postgres://test:test@localhost:5433/test";

/** The environment the e2e web server boots with (Playwright webServer.env). */
export function serverEnv(): Record<string, string> {
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(E2E_PORT),
    APP_URL: E2E_BASE_URL,
    DATABASE_URL: E2E_DATABASE_URL,
    REGISTRATION_ENABLED: "true",
    BRAND_NAME: "PostStack",
    // 32+ char secrets (validated at boot).
    ENCRYPTION_KEY: "e2e-encryption-key-0123456789abcdef0123456789",
    JWT_SECRET: "e2e-jwt-secret-0123456789abcdef0123456789abcdef",
    CRON_SECRET: "e2e-cron-secret-0123456789abcdef0123456789abcdef",
    // Force the offline JWKS fallback path: an unreachable live endpoint → the server uses
    // SELLF_JWKS_FALLBACK to verify our minted PRO token.
    LICENSE_JWKS_URL: "http://127.0.0.1:9/jwks",
    LICENSE_PRODUCT_SLUG: "poststack",
    SELLF_JWKS_FALLBACK: jwksFallbackJson(),
    // No revocation in e2e (empty disables it).
    LICENSE_REVOCATION_URL: "",
    // Storage falls back to in-memory; Meta/OAuth unconfigured (UI tests don't publish).
  };
}
