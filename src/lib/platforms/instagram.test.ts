import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

// instagram.ts transitively loads `@/lib/env` (validated at import), so set the required vars
// and import the provider dynamically once they're in place.
let InstagramProvider: typeof import("./instagram").InstagramProvider;

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://localhost/x";
  process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
  process.env.CRON_SECRET = "test-cron-secret-at-least-32-characters-long";
  process.env.APP_URL = "http://localhost:3000";
  process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
  ({ InstagramProvider } = await import("./instagram"));
});

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("InstagramProvider.subscribePageWebhooks", () => {
  it("subscribes the complete page-valid field set (echoes/reactions/receipts), without the invalid `comments` page field", async () => {
    const ig = new InstagramProvider();
    await ig.subscribePageWebhooks("PAGE-1", "page-token");

    const call = calls.find((c) => c.url.includes("/subscribed_apps"))!;
    expect(call).toBeDefined();
    const fields = JSON.parse(call.init!.body as string).subscribed_fields.split(",");
    expect(fields).toContain("messages");
    expect(fields).toContain("messaging_postbacks");
    expect(fields).toContain("message_reactions");
    expect(fields).toContain("message_echoes");
    expect(fields).toContain("message_reads");
    expect(fields).toContain("message_deliveries");
    // `comments` is an `instagram`-object field, NOT a valid `page` field (Graph #100) — including it
    // would fail the whole subscribed_apps POST. IG comments ride the app-level instagram subscription.
    expect(fields).not.toContain("comments");
  });
});

describe("InstagramProvider.subscribeMessagingWebhooks (IG-Login per-account)", () => {
  it("POSTs subscribed_apps on graph.instagram.com with messages,messaging_postbacks + the IGQW token", async () => {
    const ig = new InstagramProvider();
    const ok = await ig.subscribeMessagingWebhooks("IGQW_TOK", "17841400000");
    expect(ok).toBe(true);

    const call = calls.find((c) => c.url.includes("/17841400000/subscribed_apps"))!;
    expect(call).toBeDefined();
    expect(call.init?.method).toBe("POST");
    // IG-Login native call goes to graph.instagram.com (NOT graph.facebook.com).
    expect(call.url).toContain("graph.instagram.com");
    expect(call.url).not.toContain("graph.facebook.com");
    const u = new URL(call.url);
    const fields = (u.searchParams.get("subscribed_fields") ?? "").split(",");
    expect(fields).toContain("messages");
    expect(fields).toContain("messaging_postbacks");
    expect(u.searchParams.get("access_token")).toBe("IGQW_TOK");
  });

  it("returns false (not throw) when Graph rejects the subscription", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 });
    }) as typeof fetch;
    const ig = new InstagramProvider();
    expect(await ig.subscribeMessagingWebhooks("IGQW_TOK", "17841400000")).toBe(false);
  });
});

describe("InstagramProvider.getPostUrl", () => {
  it("resolves a media id to its public permalink", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ permalink: "https://www.instagram.com/reel/DYuqTvIFHO2/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const ig = new InstagramProvider();
    const url = await ig.getPostUrl({ access_token: "tok" }, "18115367134699712");

    expect(url).toBe("https://www.instagram.com/reel/DYuqTvIFHO2/");
    const call = calls.find((c) => c.url.includes("18115367134699712"))!;
    expect(call.url).toContain("fields=permalink");
    expect(call.url).toContain("access_token=tok");
  });

  it("returns null when the API omits a permalink", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "18115367134699712" }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
    const ig = new InstagramProvider();
    expect(await ig.getPostUrl({ access_token: "tok" }, "18115367134699712")).toBeNull();
  });
});

describe("InstagramProvider.getPostText", () => {
  it("resolves a media id to its caption (ADCTX2)", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ caption: "New drop! 🎉" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const ig = new InstagramProvider();
    const text = await ig.getPostText({ access_token: "tok" }, "18115367134699712");

    expect(text).toBe("New drop! 🎉");
    const call = calls.find((c) => c.url.includes("18115367134699712"))!;
    expect(call.url).toContain("fields=caption");
    expect(call.url).toContain("access_token=tok");
  });

  it("returns null when the API omits a caption", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "18115367134699712" }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as typeof fetch;
    const ig = new InstagramProvider();
    expect(await ig.getPostText({ access_token: "tok" }, "18115367134699712")).toBeNull();
  });

  it("throws on a non-ok response (caller decides best-effort handling)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 500 })) as typeof fetch;
    const ig = new InstagramProvider();
    await expect(ig.getPostText({ access_token: "tok" }, "x")).rejects.toThrow();
  });
});

describe("InstagramProvider.sendMessage messaging window", () => {
  const send = (call: { init?: RequestInit }) => JSON.parse(call.init!.body as string);

  it("defaults to messaging_type RESPONSE (within the 24h window)", async () => {
    const ig = new InstagramProvider();
    await ig.sendMessage({ access_token: "tok" }, "PSID-1", { text: "hi" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("RESPONSE");
    expect(body.tag).toBeUndefined();
  });

  it("uses MESSAGE_TAG + HUMAN_AGENT when the tag is requested (past the 24h window)", async () => {
    const ig = new InstagramProvider();
    await ig.sendMessage({ access_token: "tok" }, "PSID-1", { text: "late reply" }, { messagingTag: "HUMAN_AGENT" });
    const body = send(calls.find((c) => c.url.includes("/me/messages"))!);
    expect(body.messaging_type).toBe("MESSAGE_TAG");
    expect(body.tag).toBe("HUMAN_AGENT");
  });
});

describe("InstagramProvider.getUserProfile", () => {
  it("resolves name + username + avatar for an IGSID", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(JSON.stringify({ name: "Ada", username: "ada_ig", profile_pic: "https://x/a.jpg" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const ig = new InstagramProvider();
    const p = await ig.getUserProfile({ access_token: "tok" }, "IGSID-1");
    expect(p).toEqual({ name: "Ada", username: "ada_ig", profilePicture: "https://x/a.jpg" });
    expect(calls[0].url).toContain("/IGSID-1?fields=name,username,profile_pic");
  });

  it("returns null on failure (best-effort)", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("net"); }) as typeof fetch;
    const ig = new InstagramProvider();
    expect(await ig.getUserProfile({ access_token: "t" }, "IGSID-2")).toBeNull();
  });
});

describe("InstagramProvider.sendPrivateReply", () => {
  it("returns the message id so the echo of our DM can be deduped", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ recipient_id: "u1", message_id: "m_PRIG" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const ig = new InstagramProvider();
    const r = await ig.sendPrivateReply({ access_token: "t" }, "COMMENT-1", { text: "hi" });
    expect(r).toEqual({ platformMessageId: "m_PRIG" });
  });
});
