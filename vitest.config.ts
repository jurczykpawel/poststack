import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Integration tests need a real Postgres (see vitest.integration.config.ts);
    // keep them out of the default unit run so `npm test` stays infra-free.
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
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
