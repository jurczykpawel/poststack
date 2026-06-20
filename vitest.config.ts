import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // STATSCACHE1: disable the dashboard stats memo in tests so assertions read live DB state, not a
    // cached snapshot. The cache logic itself is covered by src/lib/cache/ttl-cache.test.ts; the
    // wiring (cache ON) by dashboard-stats-cache.integration.test.ts, which overrides this per-file.
    env: { STATS_CACHE_TTL_MS: "0" },
    // Integration tests need a real Postgres (see vitest.integration.config.ts);
    // keep them out of the default unit run so `npm test` stays infra-free. The e2e/ dir is the
    // Playwright browser suite (`npm run test:e2e`) — its *.spec.ts use Playwright's runner, not
    // vitest, so exclude it (vitest's default include matches *.spec.ts too).
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts", "e2e/**", ".claude/**", "landing/**"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
