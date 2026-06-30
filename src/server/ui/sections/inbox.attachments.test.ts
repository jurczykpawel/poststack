import { describe, it, expect, beforeAll } from "vitest";

// Stub env vars before any imports that trigger env validation.
process.env.DATABASE_URL ||= "postgres://x:y@localhost:5432/z";
process.env.JWT_SECRET ||= "test-secret-at-least-32-characters-long";
process.env.ENCRYPTION_KEY ||= "0".repeat(64);
process.env.APP_URL ||= "http://localhost:3000";
process.env.CRON_SECRET ||= "test-cron-secret-at-least-32-characters-long";

let renderMessages: typeof import("@/server/routes/dashboard").renderMessages;

const s = (h: unknown) => String(h);

function msg(over: Record<string, unknown> = {}) {
  return {
    kind: "message" as const,
    id: "m-1",
    direction: "outbound",
    text: null,
    attachments: null,
    quickReplyPayload: null,
    postbackPayload: null,
    createdAt: new Date("2026-06-30T12:00:00Z"),
    deliveredAt: null,
    readAt: null,
    ...over,
  };
}

beforeAll(async () => {
  ({ renderMessages } = await import("@/server/routes/dashboard"));
});

describe("renderMessages — message body (attachments/buttons/quick-replies)", () => {
  it("renders button titles instead of opaque (attachment)", () => {
    const out = s(renderMessages([msg({ attachments: { buttons: [{ title: "Chcę odebrać" }] } })] as never));
    expect(out).toContain("Chcę odebrać");
    expect(out).not.toContain("(attachment)");
  });

  it("renders quick-reply titles", () => {
    const out = s(renderMessages([msg({ attachments: { quick_replies: [{ title: "Tak" }, { title: "Nie" }] } })] as never));
    expect(out).toContain("Tak");
    expect(out).toContain("Nie");
    expect(out).not.toContain("(attachment)");
  });

  it("renders media as a labelled link (label + url, not an <img>)", () => {
    const out = s(renderMessages([msg({ attachments: { media: [{ type: "image", url: "https://cdn.example/x.jpg" }] } })] as never));
    expect(out).toContain("Image");
    expect(out).toContain("https://cdn.example/x.jpg");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("(attachment)");
  });

  it("still renders plain text for a text-only message", () => {
    const out = s(renderMessages([msg({ text: "hello world" })] as never));
    expect(out).toContain("hello world");
    expect(out).not.toContain("(attachment)");
  });

  it("escapes button titles (no raw HTML injection)", () => {
    const out = s(renderMessages([msg({ attachments: { buttons: [{ title: "<script>alert(1)</script>" }] } })] as never));
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes media urls", () => {
    const out = s(renderMessages([msg({ attachments: { media: [{ type: "file", url: 'https://x/"><script>' }] } })] as never));
    expect(out).not.toContain('"><script>');
  });

  it("shows a subtle 'tapped' line for an inbound tap with no text", () => {
    const out = s(renderMessages([msg({ direction: "inbound", text: null, postbackPayload: "CLAIM_LM" })] as never));
    expect(out).toContain("tapped");
    expect(out).toContain("CLAIM_LM");
    expect(out).not.toContain("(attachment)");
  });

  it("falls back to (no content) when there is genuinely nothing to show", () => {
    const out = s(renderMessages([msg()] as never));
    expect(out).toContain("(no content)");
  });
});
