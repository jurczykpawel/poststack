import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";

let app: Hono;

beforeAll(async () => {
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.ENCRYPTION_KEY =
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.APP_URL = "http://localhost:3000";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5433/replystack_dev";
  const { buildApp } = await import("../app");
  app = buildApp();
});

// Every v1 endpoint must be wired and reject unauthenticated requests with 401
// before touching the database. This is the port-parity guard for B1.
const ENDPOINTS: Array<[string, string]> = [
  ["GET", "/api/v1/channels"],
  ["GET", "/api/v1/channels/abc"],
  ["PATCH", "/api/v1/channels/abc"],
  ["DELETE", "/api/v1/channels/abc"],
  ["POST", "/api/v1/channels/connect-token"],
  ["POST", "/api/v1/channels/abc/drain"],
  ["GET", "/api/v1/channels/abc/posts"],
  ["GET", "/api/v1/contacts"],
  ["GET", "/api/v1/contacts/abc"],
  ["PATCH", "/api/v1/contacts/abc"],
  ["DELETE", "/api/v1/contacts/abc"],
  ["GET", "/api/v1/conversations"],
  ["GET", "/api/v1/conversations/abc"],
  ["PATCH", "/api/v1/conversations/abc"],
  ["GET", "/api/v1/conversations/abc/messages"],
  ["POST", "/api/v1/conversations/abc/messages"],
  ["GET", "/api/v1/rules"],
  ["POST", "/api/v1/rules"],
  ["GET", "/api/v1/rules/abc"],
  ["PATCH", "/api/v1/rules/abc"],
  ["DELETE", "/api/v1/rules/abc"],
  ["GET", "/api/v1/sequences"],
  ["POST", "/api/v1/sequences"],
  ["GET", "/api/v1/sequences/abc"],
  ["PATCH", "/api/v1/sequences/abc"],
  ["DELETE", "/api/v1/sequences/abc"],
  ["POST", "/api/v1/sequences/abc/enroll"],
  ["GET", "/api/v1/api-keys"],
  ["POST", "/api/v1/api-keys"],
  ["DELETE", "/api/v1/api-keys/abc"],
  ["GET", "/api/v1/audit-log"],
  ["POST", "/api/v1/messages/prune"],
  ["POST", "/api/v1/webhook-events/prune"],
  ["GET", "/api/v1/workspace"],
  ["PATCH", "/api/v1/workspace"],
  ["GET", "/api/v1/tags"],
  ["POST", "/api/v1/tags"],
];

describe("v1 routes — wired + auth-gated", () => {
  it.each(ENDPOINTS)("%s %s returns 401 without auth", async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
