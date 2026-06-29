import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";

// Integration tests against a real Postgres. Requires TEST_DATABASE_URL.
// Run: TEST_DATABASE_URL=postgres://... npm run test:integration
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.integration.test.ts"],
    // Mirror the unit config's exclusions. Critically, keep `.claude/**` out: this repo uses git
    // worktrees rooted at `.claude/worktrees/`, each a full checkout carrying its own copy of every
    // *.integration.test.ts. Without this exclude, running the suite from the main checkout collects
    // EVERY worktree's copy and runs them all against the single shared TEST_DATABASE_URL — the
    // duplicate suites seed and truncate the same tables, clobbering each other's rows and producing
    // spurious failures (count drift, wrong-schema SQL from a feature branch, "module is not a
    // function") that don't exist in any single checkout. e2e/ is the Playwright suite (own runner)
    // and landing/ is the Astro site — neither holds vitest specs.
    exclude: [...configDefaults.exclude, ".claude/**", "e2e/**", "landing/**"],
    // Install the graphile_worker schema once before any suite: emitEvent now enqueues a dispatch job
    // transactionally (WHOUT1), so emitting an event / creating a contact needs the queue schema present.
    globalSetup: ["./tests/integration-setup.ts"],
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
