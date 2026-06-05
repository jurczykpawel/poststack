import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Integration tests against a real Postgres. Requires TEST_DATABASE_URL.
// Run: TEST_DATABASE_URL=postgres://... npm run test:integration
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
});
