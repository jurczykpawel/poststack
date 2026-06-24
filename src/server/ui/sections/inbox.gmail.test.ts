import { describe, it, expect, beforeAll } from "vitest";

// Stub env vars before any imports that trigger env validation.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderThread: typeof import("@/server/routes/dashboard").renderThread;
let renderMessages: typeof import("@/server/routes/dashboard").renderMessages;

const s = (h: unknown) => String(h);

function makeConv(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv-1",
    platform: "facebook",
    status: "open",
    thread_type: "dm" as const,
    thread_ref: "",
    is_automation_paused: false,
    needs_manual_reply: false,
    assigned_to: null,
    last_inbound_at: null,
    subject: null,
    channel: { id: "ch-1", display_name: "Page", platform: "facebook" },
    contact: {
      id: "c-1",
      display_name: "Alice",
      avatar_url: null,
      contact_channels: [{ platform_sender_id: "ps-1", platform_username: null }],
    },
    ...overrides,
  };
}

beforeAll(async () => {
  ({ renderThread, renderMessages } = await import("@/server/routes/dashboard"));
});

describe("renderThread — email conversation", () => {
  it("shows subject as thread title for gmail conversation", async () => {
    const conv = makeConv({ platform: "gmail", thread_type: "email" as const, subject: "Faktura 3/2026" });
    const out = s(await renderThread(conv, []));
    expect(out).toContain("Faktura 3/2026");
  });

  it("shows sender email in the header for gmail conversation", async () => {
    const conv = makeConv({
      platform: "gmail",
      thread_type: "email" as const,
      subject: "Faktura 3/2026",
      contact: {
        id: "c-2",
        display_name: null,
        avatar_url: null,
        contact_channels: [{ platform_sender_id: "jan@firma.pl", platform_username: "jan@firma.pl" }],
      },
    });
    const out = s(await renderThread(conv, []));
    expect(out).toContain("Faktura 3/2026");
    expect(out).toContain("jan@firma.pl");
  });

  it("falls back to (no subject) when subject is null", async () => {
    const conv = makeConv({ platform: "gmail", thread_type: "email" as const, subject: null });
    const out = s(await renderThread(conv, []));
    expect(out).toContain("(no subject)");
  });

  it("falls back to (no subject) when subject is empty string", async () => {
    const conv = makeConv({ platform: "gmail", thread_type: "email" as const, subject: "" });
    const out = s(await renderThread(conv, []));
    expect(out).toContain("(no subject)");
  });

  it("does NOT inject a subject line for non-email conversations", async () => {
    const conv = makeConv({ platform: "facebook", thread_type: "dm" as const, subject: null });
    const out = s(await renderThread(conv, []));
    expect(out).not.toContain("no subject");
    expect(out).not.toContain("From: Alice");
  });
});

describe("renderMessages — email empty state", () => {
  it("shows email-specific empty state for email thread type", async () => {
    const out = s(await renderMessages([], "email"));
    expect(out).toContain("No emails yet");
  });

  it("shows DM empty state for dm thread type", async () => {
    const out = s(await renderMessages([], "dm"));
    expect(out).toContain("say hello");
    expect(out).not.toContain("No emails yet");
  });

  it("shows comment empty state for comment thread type", async () => {
    const out = s(await renderMessages([], "comment"));
    expect(out).toContain("comment thread");
    expect(out).not.toContain("No emails yet");
  });
});
