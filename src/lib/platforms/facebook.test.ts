import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// facebook.ts transitively loads `@/lib/env` (validated at import); set required vars first.
let FacebookProvider: typeof import("./facebook").FacebookProvider;

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  ({ FacebookProvider } = await import("./facebook"));
});

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ message_id: "m1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("FacebookProvider.sendMessage messaging window", () => {
  const send = (call: { init?: RequestInit }) => JSON.parse(call.init!.body as string);

  it("defaults to messaging_type RESPONSE (within the 24h window)", async () => {
    const fb = new FacebookProvider();
    await fb.sendMessage({ access_token: "tok" }, "PSID-1", { text: "hi" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.tag).toBeUndefined();
  });

  it("uses MESSAGE_TAG + HUMAN_AGENT when the tag is requested (past the 24h window)", async () => {
    const fb = new FacebookProvider();
    await fb.sendMessage({ access_token: "tok" }, "PSID-1", { text: "late reply" }, { messagingTag: "HUMAN_AGENT" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("MESSAGE_TAG");
    expect(body.tag).toBe("HUMAN_AGENT");
  });
});

describe("FacebookProvider.getUserProfile", () => {
  it("resolves name + avatar for a PSID via the page token", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ name: "Jan Kowalski", profile_pic: "https://x/p.jpg" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const fb = new FacebookProvider();
    const p = await fb.getUserProfile({ access_token: "pagetok" }, "PSID-9");
    expect(p).toEqual({ name: "Jan Kowalski", profilePicture: "https://x/p.jpg" });
    expect(calls[0].url).toContain("/PSID-9?fields=name,profile_pic");
    expect(calls[0].url).toContain("access_token=pagetok");
  });

  it("returns null (best-effort) on a non-200 — never throws", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 400 })) as typeof fetch;
    const fb = new FacebookProvider();
    expect(await fb.getUserProfile({ access_token: "t" }, "PSID-X")).toBeNull();
  });
});

describe("FacebookProvider.getPostText", () => {
  it("resolves a Page post id to its message text (ADCTX2)", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ id: "PAGE_POST-1", message: "We shipped a new feature today!" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const fb = new FacebookProvider();
    const text = await fb.getPostText({ access_token: "pagetok" }, "PAGE_POST-1");
    expect(text).toBe("We shipped a new feature today!");
    expect(calls[0].url).toContain("/PAGE_POST-1?fields=message");
    expect(calls[0].url).toContain("access_token=pagetok");
  });

  it("returns null when the API omits a message (e.g. an image-only post)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "PAGE_POST-2" }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
    const fb = new FacebookProvider();
    expect(await fb.getPostText({ access_token: "t" }, "PAGE_POST-2")).toBeNull();
  });

  it("throws on a non-ok response (caller decides best-effort handling)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 400 })) as typeof fetch;
    const fb = new FacebookProvider();
    await expect(fb.getPostText({ access_token: "t" }, "PAGE_POST-3")).rejects.toThrow();
  });
});

describe("FacebookProvider.sendPrivateReply", () => {
  it("returns the message id so the echo of our DM can be deduped", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ recipient_id: "u1", message_id: "m_PR123" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const fb = new FacebookProvider();
    const r = await fb.sendPrivateReply({ access_token: "t" }, "COMMENT-1", { text: "hi" });
    expect(r).toEqual({ platformMessageId: "m_PR123" });
  });
});
