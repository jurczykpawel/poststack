import { describe, it, expect } from "vitest";

// env validated at module import time — set before the dynamic import of ./gmail.
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.APP_URL = "http://localhost:3000";
process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";

const { GmailProvider } = await import("./gmail");

describe("GmailProvider", () => {
  const p = new GmailProvider();

  it("canonicalizes gmail.com: strips dots + plus, unifies googlemail", () => {
    expect(p.canonicalizeAddress("J.a.N+promo@googlemail.com")).toBe("jan@gmail.com");
  });

  it("canonicalizes workspace domains conservatively: strips plus, keeps dots", () => {
    expect(p.canonicalizeAddress("Jan.Kowalski+x@firma.pl")).toBe("jan.kowalski@firma.pl");
  });

  it("buildRawMessage produces threaded RFC822 base64url", () => {
    const { raw } = p.buildRawMessage({
      to: "jan@firma.pl",
      subject: "Re: Hi",
      text: "hello",
      inReplyTo: "<abc@mail>",
      references: "<abc@mail>",
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("To: jan@firma.pl");
    expect(decoded).toContain("Subject: Re: Hi");
    expect(decoded).toContain("In-Reply-To: <abc@mail>");
    expect(decoded).toContain("References: <abc@mail>");
    expect(decoded).toContain("hello");
  });

  it("buildRawMessage RFC 2047-encodes a non-ASCII (Polish) subject so it isn't mojibake", () => {
    const { raw } = p.buildRawMessage({ to: "jan@firma.pl", subject: "Zażółć gęślą", text: "cześć" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const b64 = Buffer.from("Zażółć gęślą", "utf8").toString("base64");
    expect(decoded).toContain(`Subject: =?UTF-8?B?${b64}?=`);
    expect(decoded).not.toContain("Subject: Zażółć gęślą");
  });

  it("buildRawMessage leaves a pure-ASCII subject unencoded", () => {
    const { raw } = p.buildRawMessage({ to: "jan@firma.pl", subject: "Re: Hello", text: "hi" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).toContain("Subject: Re: Hello");
  });

  it("buildRawMessage omits threading headers for a fresh send", () => {
    const { raw } = p.buildRawMessage({ to: "jan@firma.pl", subject: "Hi", text: "hello" });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    expect(decoded).not.toContain("In-Reply-To:");
    expect(decoded).not.toContain("References:");
  });

  it("requiresTokenRefresh is true", () => {
    expect(p.requiresTokenRefresh()).toBe(true);
  });

  it("parses a multipart messages.get payload into a NormalizedEmail", () => {
    const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const msg = {
      id: "msg-1",
      threadId: "thread-1",
      internalDate: "1700000000000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: '"Jan Kowalski" <jan@firma.pl>' },
          { name: "Subject", value: "Witaj" },
          { name: "Message-ID", value: "<real-msg-id@firma.pl>" },
        ],
        parts: [
          { mimeType: "text/plain", headers: [], body: { data: b64url("plain body") } },
          { mimeType: "text/html", headers: [], body: { data: b64url("<p>html body</p>") } },
        ],
      },
    };
    const email = p.parseMessage(msg);
    expect(email.messageId).toBe("<real-msg-id@firma.pl>");
    expect(email.threadId).toBe("thread-1");
    expect(email.fromEmail).toBe("jan@firma.pl");
    expect(email.fromName).toBe("Jan Kowalski");
    expect(email.subject).toBe("Witaj");
    expect(email.internalDate).toBe(1700000000000);
    expect(email.text).toBe("plain body");
  });

  it("parses an html-only payload, falling back to bodyToText", () => {
    const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const msg = {
      id: "msg-2",
      threadId: "thread-2",
      internalDate: "1700000001000",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "noname@example.com" },
          { name: "Subject", value: "HTML" },
        ],
        body: { data: b64url("<p>Hello <b>world</b></p>") },
      },
    };
    const email = p.parseMessage(msg);
    expect(email.fromEmail).toBe("noname@example.com");
    expect(email.fromName).toBeUndefined();
    expect(email.messageId).toBe("msg-2"); // no Message-ID header → falls back to Gmail id
    expect(email.text).toContain("Hello");
    expect(email.text).toContain("world");
  });
});
