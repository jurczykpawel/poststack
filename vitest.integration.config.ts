import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Integration tests against a real Postgres. Requires TEST_DATABASE_URL.
// Run: TEST_DATABASE_URL=postgres://... npm run test:integration
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.integration.test.ts"],
    // STATSCACHE1: stats memo OFF by default so live∪stats merge tests read real DB state. The
    // caching wiring is proven with the cache ON in dashboard-stats-cache.integration.test.ts, which
    // sets STATS_CACHE_TTL_MS itself (before importing dashboard) to override this.
    env: { STATS_CACHE_TTL_MS: "0" },
    // Integration tests share one Postgres + graphile queue; run files serially
    // so worker-draining suites don't consume each other's enqueued jobs.
    fileParallelism: false,
    // Real PG + graphile cold-init (first addJob warms the queue schema/pool) can exceed vitest's
    // 5s default on a cold CI runner — a timed-out test also leaks its still-running enqueue into the
    // next test (job-count drift). A generous timeout removes that flaky class for real-infra tests.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
