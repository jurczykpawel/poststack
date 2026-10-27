import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
import { E2E_BASE_URL, serverEnv } from "./e2e/env";

export default defineConfig({
  ...base,
  projects: base.projects!.filter((p) => p.name !== "captcha").map((p) => p.name === "chromium"
    ? { ...p, testIgnore: /captcha\.spec\.ts/, testMatch: /tiktok-compose\.spec\.ts/ } : p),
  webServer: {
    command: "bun --no-env-file e2e/fixtures/tiktok-server.ts",
    url: `${E2E_BASE_URL}/login`, timeout: 60_000, reuseExistingServer: false,
    env: serverEnv(), stdout: "pipe", stderr: "pipe",
  },
});
