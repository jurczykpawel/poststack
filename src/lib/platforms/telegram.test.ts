import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramProvider } from "./telegram";
import { TokenInvalidError } from "./errors";

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => { status?: number; body: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("TelegramProvider", () => {
  it("connectWithToken validates via getMe and registers a webhook is separate", async () => {
    mockFetch(() => ({ body: { ok: true, result: { id: 777, is_bot: true, first_name: "MyBot", username: "my_bot" } } }));
    const tg = new TelegramProvider();
    const accounts = await tg.connectWithToken("123:ABC");

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ platformId: "777", username: "my_bot", tokens: { access_token: "123:ABC" } });
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:ABC/getMe");
  });

  it("connectWithToken throws on an invalid token", async () => {
    mockFetch(() => ({ status: 401, body: { ok: false, description: "Unauthorized" } }));
    const tg = new TelegramProvider();
    await expect(tg.connectWithToken("bad")).rejects.toThrow(/Invalid Telegram bot token/);
  });

  it("setWebhook posts the url + secret_token and limits updates to messages", async () => {
    mockFetch(() => ({ body: { ok: true, result: true } }));
    const tg = new TelegramProvider();
    await tg.setWebhook("123:ABC", "https://app.test/api/webhooks/telegram", "sek-ret");

    const call = calls.find((c) => c.url.endsWith("/setWebhook"))!;
    const body = JSON.parse(call.init!.body as string);
    expect(body.url).toBe("https://app.test/api/webhooks/telegram");
    expect(body.secret_token).toBe("sek-ret");
    expect(body.allowed_updates).toEqual(["message"]);
  });

  it("sendMessage posts chat_id + text and returns the message id", async () => {
    mockFetch(() => ({ body: { ok: true, result: { message_id: 42 } } }));
    const tg = new TelegramProvider();
    const sent = await tg.sendMessage({ access_token: "123:ABC" }, "555", { text: "Hi" });

    const call = calls.find((c) => c.url.endsWith("/sendMessage"))!;
    const body = JSON.parse(call.init!.body as string);
    expect(body).toEqual({ chat_id: "555", text: "Hi" });
    expect(sent.platformMessageId).toBe("42");
  });

  it("sendMessage throws a generic (transient) error on a non-auth Telegram failure", async () => {
    mockFetch(() => ({ status: 400, body: { ok: false, description: "chat not found" } }));
    const tg = new TelegramProvider();
    const err = await tg.sendMessage({ access_token: "t" }, "1", { text: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TokenInvalidError);
    expect(String(err)).toMatch(/Telegram send message failed/);
  });

  //  — a revoked/regenerated bot token (401) or blocked bot (403) is a re-auth case, so the
  // delivery state machine parks + flags needs_reauth instead of retrying to the dead-letter queue.
  it("sendMessage throws TokenInvalidError on 401 (revoked token)", async () => {
    mockFetch(() => ({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } }));
    const tg = new TelegramProvider();
    await expect(tg.sendMessage({ access_token: "dead" }, "1", { text: "x" })).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("sendMessage throws TokenInvalidError on 403 (bot blocked/kicked)", async () => {
    mockFetch(() => ({ status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }));
    const tg = new TelegramProvider();
    await expect(tg.sendMessage({ access_token: "t" }, "1", { text: "x" })).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("does not support OAuth or comments", () => {
    const tg = new TelegramProvider();
    expect(() => tg.generateAuthUrl()).toThrow();
    expect(tg.sendComment).toBeUndefined();
    expect(tg.requiresTokenRefresh()).toBe(false);
    expect(tg.supportsFeature("comments")).toBe(false);
    expect(tg.supportsFeature("token_connect")).toBe(true);
  });
});
