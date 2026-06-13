import { describe, it, expect, beforeAll } from "vitest";

process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

let GET: typeof import("./route").GET;

beforeAll(async () => {
  ({ GET } = await import("./route"));
});

describe("GET /api/oauth/connect/:platform — auth gate", () => {
  it("rejects an unauthenticated request with 401 (no redirect leaked)", async () => {
    const res = await GET(new Request("http://localhost/api/oauth/connect/tiktok"), "tiktok");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});
