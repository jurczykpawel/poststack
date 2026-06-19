import { defineConfig } from "vitest/config";

// Landing has its own unit suite (pure presentation logic like fleet-stats). It runs with the
// landing's own deps via `npm test` here — NOT the app's root vitest (which excludes `landing/**`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
