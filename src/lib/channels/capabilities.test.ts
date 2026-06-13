import { describe, it, expect, beforeAll } from "vitest";

// Importing the capability resolver pulls in the platform providers, which transitively load env.
// Satisfy the env schema before the dynamic import (the established unit-test pattern in this repo).
process.env.DATABASE_URL ??= "postgres://u:p@localhost:5432/db";
process.env.JWT_SECRET ??= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ??= "test-encryption-key-at-least-32-characters-long";
process.env.APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret-at-least-32-characters-long";

let CAPABILITIES: typeof import("./capabilities").CAPABILITIES;
let channelCapabilities: typeof import("./capabilities").channelCapabilities;
let can: typeof import("./capabilities").can;
type Capability = import("./capabilities").Capability;

beforeAll(async () => {
  ({ CAPABILITIES, channelCapabilities, can } = await import("./capabilities"));
});

// CHANNELS-ARCHITECTURE (Task 6): a channel is an account with CAPABILITIES, resolved from
// platform × connection_mode × provider — never a "publish channel" vs "reply channel". The engine
// asks can(channel, "publish") / can(channel, "dm"); zero platform if-ladders live in the engine.
const caps = (platform: string, extra: Partial<{ connection_mode: "oauth" | "manual_token" | "derived" }> = {}) =>
  channelCapabilities({ platform, connection_mode: extra.connection_mode ?? "oauth" });

describe("channel capabilities — derived from provider, not stored", () => {
  it("the capability set is a small closed enum", () => {
    expect([...CAPABILITIES].sort()).toEqual(
      ["comment_reply", "dm", "enumerate_subaccounts", "poll_comments", "publish", "receive_webhooks"].sort(),
    );
  });

  it("instagram: publishes AND replies AND DMs AND receives webhooks (the unified account)", () => {
    const s = caps("instagram");
    expect(s).toContain("publish");
    expect(s).toContain("comment_reply");
    expect(s).toContain("dm");
    expect(s).toContain("receive_webhooks");
  });

  it("facebook: same unified surface as instagram", () => {
    const s = caps("facebook");
    expect(s).toEqual(expect.arrayContaining(["publish", "comment_reply", "dm", "receive_webhooks"]));
  });

  it("youtube: publishes + comment-replies + polls comments, but has NO DM", () => {
    const s = caps("youtube");
    expect(s).toContain("publish");
    expect(s).toContain("comment_reply");
    expect(s).toContain("poll_comments");
    expect(s).not.toContain("dm");
  });

  it("tiktok / x / linkedin / threads: publish-only (no inbound provider registered)", () => {
    for (const p of ["tiktok", "twitter", "linkedin", "threads"]) {
      const s = caps(p);
      expect(s).toContain("publish");
      expect(s).not.toContain("comment_reply");
      expect(s).not.toContain("dm");
    }
  });

  it("telegram: DM-only (inbound bot, no publish provider, no comment surface)", () => {
    const s = caps("telegram");
    expect(s).toContain("dm");
    expect(s).not.toContain("publish");
    expect(s).not.toContain("comment_reply");
  });

  it("enumerate_subaccounts: a non-derived meta credential can act as a master; a derived child cannot", () => {
    expect(caps("instagram", { connection_mode: "manual_token" })).toContain("enumerate_subaccounts");
    expect(caps("facebook", { connection_mode: "oauth" })).toContain("enumerate_subaccounts");
    // a minted (derived) child descends from its source — it never enumerates further.
    expect(caps("instagram", { connection_mode: "derived" })).not.toContain("enumerate_subaccounts");
    // non-meta platforms never enumerate.
    expect(caps("youtube", { connection_mode: "oauth" })).not.toContain("enumerate_subaccounts");
  });

  it("can(channel, cap) is the engine's only question", () => {
    const ig = { platform: "instagram", connection_mode: "oauth" as const };
    expect(can(ig, "publish")).toBe(true);
    expect(can(ig, "dm")).toBe(true);
    const tt = { platform: "tiktok", connection_mode: "oauth" as const };
    expect(can(tt, "publish")).toBe(true);
    expect(can(tt, "comment_reply")).toBe(false);
  });

  it("an unknown platform has no capabilities (never throws)", () => {
    const s: Capability[] = caps("myspace");
    expect(s).toEqual([]);
  });
});
