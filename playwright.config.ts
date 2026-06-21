import { defineConfig, devices } from "@playwright/test";
import {
  E2E_PORT,
  E2E_BASE_URL,
  E2E_DATABASE_URL,
  CAPTCHA_E2E_BASE_URL,
  serverEnv,
  captchaServerEnv,
} from "./e2e/env";

// Browser e2e for the unified app. Boots `bun src/server/index.ts` against a DEDICATED e2e Postgres
// (unify_e2e on :5433) so it never collides with the unit/integration gate's shared `test` DB.
// global-setup creates+migrates the DB, registers the admin, seeds rows, and saves storageState.
// Specs exercise every nav section in BOTH license states (FREE / PRO), toggling the license via the
// app's own /api/v1/license endpoint. NO worker needed — UI tests don't execute publishing.
export default defineConfig({
  testDir: "./e2e",
  // Section sweeps share one server + one DB; the two license states must not run concurrently
  // (the license is instance-global), so run serially with a single worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    // Registers the admin + seeds rows + saves storageState (runs after the web server is up).
    // No storageState here — it doesn't exist yet (this project creates it).
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    // The sweeps reuse the logged-in session saved by setup. Captcha runs against its own server.
    {
      name: "chromium",
      testIgnore: /captcha\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], storageState: "./e2e/.auth/state.json" },
      dependencies: ["setup"],
    },
    // Public login captcha against the captcha-enabled server. No session, no setup dependency.
    {
      name: "captcha",
      testMatch: /captcha\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: CAPTCHA_E2E_BASE_URL },
    },
  ],
  webServer: [
    {
      command: "bun src/server/index.ts",
      url: `${E2E_BASE_URL}/login`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...serverEnv() },
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "bun src/server/index.ts",
      url: `${CAPTCHA_E2E_BASE_URL}/login`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: { ...captchaServerEnv() },
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

export { E2E_PORT, E2E_BASE_URL, E2E_DATABASE_URL };
