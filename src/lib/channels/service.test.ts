import { describe, it, expect, beforeAll } from "vitest";

// service.ts transitively pulls in db + platform providers, which load + validate env at module top.
// Satisfy the env schema before the dynamic import (the established unit-test pattern in this repo).
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

let toPublic: typeof import("./service").toPublic;

beforeAll(async () => {
  ({ toPublic } = await import("./service"));
});

// A minimal hand-built channel row. Only the columns toPublic projects matter; the rest are filled
// with inert values and cast to the row type so the test stays focused on the projection.
function row(over: Record<string, unknown>): Parameters<typeof toPublic>[0] {
  return {
    id: "ch-1",
    platform: "instagram",
    platform_id: "P1",
    display_name: "Acct",
    username: "acct",
    profile_picture: null,
    status: "active",
    connection_mode: "oauth",
    brand_key: null,
    source_id: null,
    token_expires_at: null,
    data_access_expires_at: null,
    needs_reauth_reason: null,
    hidden_at: null,
    default_first_comment: null,
    default_auto_story: false,
    metadata: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    gmail_query: null,
    last_error: null,
    messaging_token_expires_at: null,
    ...over,
  } as unknown as Parameters<typeof toPublic>[0];
}

describe("toPublic — IG-Login messaging state on the dashboard projection", () => {
  it("instagram with a messaging token expiry → instagram_login, carries the date + last_error", () => {
    const exp = new Date("2026-09-01T00:00:00Z");
    const p = toPublic(row({ platform: "instagram", messaging_token_expires_at: exp, last_error: "x" }));
    expect(p.messaging_connection).toBe("instagram_login");
    expect(p.messaging_token_expires_at).toEqual(exp);
    expect(p.last_error).toBe("x");
  });

  it("instagram without a messaging token → facebook_only", () => {
    const p = toPublic(row({ platform: "instagram", messaging_token_expires_at: null }));
    expect(p.messaging_connection).toBe("facebook_only");
    expect(p.messaging_token_expires_at).toBeNull();
  });

  it("facebook → messaging_connection is null (not an IG channel)", () => {
    const p = toPublic(row({ platform: "facebook", messaging_token_expires_at: null }));
    expect(p.messaging_connection).toBeNull();
  });
});
