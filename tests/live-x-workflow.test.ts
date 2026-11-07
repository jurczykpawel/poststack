import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
it("gates monthly and manual live X runs on live-paid", () => {
  const workflow = readFileSync(".github/workflows/live-x.yml", "utf8");
  expect(workflow).toContain("environment: live-paid");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain('cron: "0 9 1 * *"');
  expect(workflow).toContain("secrets.LIVE_X_API_KEY");
  expect(workflow).toContain("vars.LIVE_X_CHANNEL_ID");
  expect(workflow).toContain("vars.TEST_BASE_URL");
  expect(workflow).not.toMatch(/sk_live_[A-Za-z0-9]+|BEGIN.*PRIVATE KEY/);
  expect(workflow).toContain("concurrency:");
});
