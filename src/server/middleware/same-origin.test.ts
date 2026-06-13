import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";

// same-origin imports @/lib/env (validated at import time), so set the required env before importing.
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
});

async function makeApp() {
  const { requireSameOrigin } = await import("./same-origin");
  const app = new Hono();
  app.use("*", requireSameOrigin);
  app.get("/x", (c) => c.text("ok"));
  app.post("/x", (c) => c.text("ok"));
  return app;
}

describe("requireSameOrigin", () => {
  it("allows a safe GET regardless of Sec-Fetch-Site", async () => {
    const res = await (await makeApp()).request("/x", { method: "GET", headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(200);
  });

  it("allows a same-origin POST", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
  });

  it("allows a same-site POST", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { "sec-fetch-site": "same-site" } });
    expect(res.status).toBe(200);
  });

  it("allows a user-initiated POST (Sec-Fetch-Site: none)", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { "sec-fetch-site": "none" } });
    expect(res.status).toBe(200);
  });

  it("refuses a POST whose Sec-Fetch-Site is cross-site", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("falls back to Origin when Sec-Fetch-Site is absent — matching host passes", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { origin: "http://localhost:3000" } });
    expect(res.status).toBe(200);
  });

  it("falls back to Origin when Sec-Fetch-Site is absent — a different host is refused", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { origin: "http://other.example" } });
    expect(res.status).toBe(403);
  });

  it("refuses a malformed Origin when Sec-Fetch-Site is absent", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST", headers: { origin: "not a url" } });
    expect(res.status).toBe(403);
  });

  it("allows a POST with neither Sec-Fetch-Site nor Origin (non-browser client)", async () => {
    const res = await (await makeApp()).request("/x", { method: "POST" });
    expect(res.status).toBe(200);
  });
});
