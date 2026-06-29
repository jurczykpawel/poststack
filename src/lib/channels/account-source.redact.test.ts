import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// A2: markSourceNeedsReauth must redact any token/secret echoed back in the failure `reason`
// (undici errors carry the Graph URL including ?access_token=…) BEFORE it is persisted to
// account_sources.{needs_reauth_reason,last_error}, cascaded to channels.last_error, or emitted in
// the alert detail — last_error is now rendered in the UI and returned by GET /api/v1/channels.

// Capture every db.update(...).set(...) argument and the dispatched alert.
const setCalls: Array<Record<string, unknown>> = [];
const alertCalls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => {
  const chain = {
    set: (arg: Record<string, unknown>) => {
      setCalls.push(arg);
      return { where: async () => undefined };
    },
  };
  return {
    db: {
      query: {
        accountSources: {
          // ok→down edge: a previously-healthy source so the alert fires.
          findFirst: async () => ({ status: "active", workspace_id: "ws-1", display_name: "Acme" }),
        },
      },
      update: () => chain,
    },
  };
});

vi.mock("@/lib/notifications/alert", () => ({
  dispatchAlert: async (a: Record<string, unknown>) => {
    alertCalls.push(a);
  },
}));

let markSourceNeedsReauth: typeof import("./account-source").markSourceNeedsReauth;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "test-encryption-key-at-least-32-characters-long";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.APP_URL = "http://localhost:3000";
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  ({ markSourceNeedsReauth } = await import("./account-source"));
});

beforeEach(() => {
  setCalls.length = 0;
  alertCalls.length = 0;
});

describe("markSourceNeedsReauth — secret redaction [A2]", () => {
  const SECRET = "EAAsecret123";
  const reason = `fetch failed https://graph.facebook.com/v25.0/me?access_token=${SECRET}`;

  it("redacts the token before persisting to needs_reauth_reason + last_error", async () => {
    await markSourceNeedsReauth("src-1", reason);

    // First update = account_sources (needs_reauth_reason + last_error); second = channels cascade.
    expect(setCalls.length).toBe(2);
    const sourceSet = setCalls[0];
    expect(sourceSet.needs_reauth_reason).not.toContain(SECRET);
    expect(sourceSet.last_error).not.toContain(SECRET);
    expect(String(sourceSet.needs_reauth_reason)).toContain("[REDACTED]");
  });

  it("redacts the token in the cascaded channels.last_error", async () => {
    await markSourceNeedsReauth("src-1", reason);
    const channelsSet = setCalls[1];
    expect(channelsSet.last_error).not.toContain(SECRET);
    expect(String(channelsSet.last_error)).toContain("[REDACTED]");
  });

  it("redacts the token in the alert detail", async () => {
    await markSourceNeedsReauth("src-1", reason);
    expect(alertCalls.length).toBe(1);
    expect(String(alertCalls[0].detail)).not.toContain(SECRET);
    expect(String(alertCalls[0].detail)).toContain("[REDACTED]");
  });
});
