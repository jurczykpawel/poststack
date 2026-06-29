import { describe, it, expect, beforeAll } from "vitest";
import { messagingConnection } from "./ig-connection";

// Importing the capability resolver pulls in the platform providers, which transitively load env.
// Satisfy the env schema before the dynamic import (the established unit-test pattern in this repo).
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

let channelCapabilities: typeof import("./capabilities").channelCapabilities;

beforeAll(async () => {
  ({ channelCapabilities } = await import("./capabilities"));
});

describe("messagingConnection", () => {
  it("Instagram with messaging_token_expires_at set → instagram_login", () => {
    expect(messagingConnection({ platform: "instagram", messaging_token_expires_at: new Date() })).toBe("instagram_login");
  });
  it("Instagram with null messaging_token_expires_at → facebook_only", () => {
    expect(messagingConnection({ platform: "instagram", messaging_token_expires_at: null })).toBe("facebook_only");
  });
  it("non-Instagram platform → null (no IG messaging concept)", () => {
    expect(messagingConnection({ platform: "facebook", messaging_token_expires_at: null })).toBeNull();
    expect(messagingConnection({ platform: "telegram", messaging_token_expires_at: null })).toBeNull();
  });
});

// F4: capability matrix — all three reachable IG channel shapes resolve the structural capabilities,
// and messagingConnection tells them apart (the token-derived nuance the structural set can't carry).
describe("IG capability matrix (F4)", () => {
  const caps = (mode: "oauth" | "manual_token" | "derived") =>
    channelCapabilities({ platform: "instagram", connection_mode: mode });
  it("every IG channel structurally supports publish + comment_reply + dm + receive_webhooks", () => {
    for (const c of ["publish", "comment_reply", "dm", "receive_webhooks"] as const) {
      expect(caps("oauth")).toContain(c);
      expect(caps("manual_token")).toContain(c);
      expect(caps("derived")).toContain(c);
    }
  });
  it("derived IG channel cannot enumerate sub-accounts", () => {
    expect(caps("derived")).not.toContain("enumerate_subaccounts");
  });
  it("messagingConnection distinguishes the shapes the structural set cannot", () => {
    expect(messagingConnection({ platform: "instagram", messaging_token_expires_at: new Date() })).toBe("instagram_login");
    expect(messagingConnection({ platform: "instagram", messaging_token_expires_at: null })).toBe("facebook_only");
  });
});
