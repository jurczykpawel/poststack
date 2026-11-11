import { describe, it, expect, afterEach, vi } from "vitest";
import { telegramProvider, resolvePublishTarget } from "./telegram";
import { validate } from "./validate";
import { isProvider } from "./index";
import { PermissionError, PermanentError, RateLimitedError, TokenInvalidError, TransientError } from "./errors";
import docs from "../../../tests/fixtures/provider-docs/telegram-responses.json";

afterEach(() => vi.unstubAllGlobals());
const tokens = { accessToken: "123:SECRET" };
const channelMetadata = { publishTarget: "@acme_news" };

type Call = { method: string; body: Record<string, unknown> };
function stub(replies: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const r = replies[method];
    return new Response(JSON.stringify(r?.body ?? {}), { status: r?.status ?? 200 });
  }));
  return calls;
}
const pub = (request: Parameters<typeof telegramProvider.publish>[0]["request"], mediaUrls: string[] = [], mediaKinds?: string[], md: Record<string, unknown> = channelMetadata) =>
  telegramProvider.publish({ tokens, accountId: "777000111", request, mediaUrls, mediaKinds, channelMetadata: md });

describe("telegram publish provider", () => {
  it("is registered, needs no refresh, and advertises Bot API limits", () => {
    expect(isProvider("telegram")).toBe(true);
    expect(telegramProvider.requiresTokenRefresh()).toBe(false);
    const caps = Object.fromEntries(telegramProvider.capabilities().map((c) => [c.format, c]));
    expect(caps.text!.caption).toEqual({ maxLength: 4096, required: true });
    expect(caps.image!.caption!.maxLength).toBe(1024);
    expect(caps.video!.caption!.maxLength).toBe(1024);
    expect(caps.image!.image!.maxSizeMB).toBe(5);
    expect(caps.video!.video!.maxSizeMB).toBe(20);
    expect(caps.carousel!.media).toMatchObject({ min: 2, max: 10 });
  });

  it("validate() rejects a 1025-char photo caption and an 11-item album", () => {
    expect(validate(telegramProvider, { format: "image", media: [{ mediaId: "a" }], caption: "x".repeat(1025) })).toMatchObject({ ok: false });
    expect(validate(telegramProvider, { format: "carousel", media: Array.from({ length: 11 }, () => ({ mediaId: "a" })) })).toMatchObject({ ok: false });
    expect(validate(telegramProvider, { format: "text", media: [], caption: "x".repeat(4096) })).toEqual({ ok: true });
  });

  it("text -> sendMessage to the target; handle = message_id; public link for @username", async () => {
    const calls = stub({ sendMessage: { body: docs.message } });
    const h = await pub({ format: "text", media: [], caption: "hello" });
    expect(calls).toEqual([{ method: "sendMessage", body: { chat_id: "@acme_news", text: "hello" } }]);
    expect(h).toEqual({ providerHandle: "101", url: "https://t.me/acme_news/101" });
  });

  it("image -> sendPhoto with URL + caption", async () => {
    const calls = stub({ sendPhoto: { body: docs.message } });
    await pub({ format: "image", media: [{ mediaId: "m" }], caption: "c" }, ["https://cdn.example/a.jpg"]);
    expect(calls[0]).toEqual({ method: "sendPhoto", body: { chat_id: "@acme_news", photo: "https://cdn.example/a.jpg", caption: "c" } });
  });

  it("video -> sendVideo with URL + caption", async () => {
    const calls = stub({ sendVideo: { body: docs.message } });
    await pub({ format: "video", media: [{ mediaId: "m" }], caption: "c" }, ["https://cdn.example/a.mp4"]);
    expect(calls[0]!.method).toBe("sendVideo");
    expect(calls[0]!.body).toMatchObject({ chat_id: "@acme_news", video: "https://cdn.example/a.mp4", caption: "c" });
  });

  it("album -> sendMediaGroup, caption only on the first item, handle lists every id first-first", async () => {
    const calls = stub({ sendMediaGroup: { body: docs.album } });
    const h = await pub({ format: "carousel", media: [{ mediaId: "a" }, { mediaId: "b" }], caption: "c" }, ["https://x/a.jpg", "https://x/b.mp4"], ["image", "video"]);
    expect(calls[0]!.body.media).toEqual([
      { type: "photo", media: "https://x/a.jpg", caption: "c" },
      { type: "video", media: "https://x/b.mp4" },
    ]);
    expect(h).toEqual({ providerHandle: "201,202", url: "https://t.me/acme_news/201" });
  });

  it("numeric target has no public link", async () => {
    stub({ sendMessage: { body: docs.message } });
    const h = await pub({ format: "text", media: [], caption: "hi" }, [], undefined, { publishTarget: "-1009876543210" });
    expect(h.url).toBeUndefined();
  });

  it("over-long caption fails before any request", async () => {
    const calls = stub({});
    await expect(pub({ format: "image", media: [{ mediaId: "m" }], caption: "x".repeat(1025) }, ["https://x/a.jpg"])).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toEqual([]);
  });

  it("missing publish target is permanent and sends nothing", async () => {
    const calls = stub({});
    await expect(pub({ format: "text", media: [], caption: "hi" }, [], undefined, {})).rejects.toThrow(/publish target/i);
    expect(calls).toEqual([]);
  });

  it.each([
    ["403 not a member", 403, docs.errForbidden],
    ["400 no rights", 400, docs.errNoRights],
    ["400 chat not found", 400, docs.errChatNotFound],
  ])("%s -> PermissionError", async (_n, status, body) => {
    stub({ sendMessage: { status, body } });
    await expect(pub({ format: "text", media: [], caption: "hi" })).rejects.toBeInstanceOf(PermissionError);
  });

  it("429 -> RateLimitedError with parameters.retry_after, safe to re-run (pre_commit)", async () => {
    stub({ sendMessage: { status: 429, body: docs.errRetry } });
    const err = await pub({ format: "text", media: [], caption: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(17);
    expect(err.phase).toBe("pre_commit");
  });

  it("401 -> TokenInvalidError; 5xx and network failure stay commit_uncertain; unknown 400 is permanent", async () => {
    stub({ sendMessage: { status: 401, body: docs.errUnauthorized } });
    await expect(pub({ format: "text", media: [], caption: "hi" })).rejects.toBeInstanceOf(TokenInvalidError);
    stub({ sendMessage: { status: 502, body: {} } });
    const e5 = await pub({ format: "text", media: [], caption: "hi" }).catch((e) => e);
    expect(e5).toBeInstanceOf(TransientError);
    expect(e5.phase).toBe("commit_uncertain");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const en = await pub({ format: "text", media: [], caption: "hi" }).catch((e) => e);
    expect(en).toBeInstanceOf(TransientError);
    expect(en.phase).toBe("commit_uncertain");
    stub({ sendPhoto: { status: 400, body: docs.errBadUrl } });
    await expect(pub({ format: "image", media: [{ mediaId: "m" }] }, ["https://x/a.jpg"])).rejects.toBeInstanceOf(PermanentError);
  });

  it("ok:true with a malformed result is not treated as published", async () => {
    stub({ sendMessage: { body: { ok: true, result: { message_id: { x: 1 } } } } });
    await expect(pub({ format: "text", media: [], caption: "hi" })).rejects.toBeInstanceOf(TransientError);
  });

  it("healthCheck returns the bot account", async () => {
    stub({ getMe: { body: docs.me } });
    expect(await telegramProvider.healthCheck(tokens)).toMatchObject({ accountId: "777000111", handle: "acme_bot" });
  });
});

describe("resolvePublishTarget", () => {
  const setup = (chat: unknown, member: unknown) => stub({ getMe: { body: docs.me }, getChat: { body: chat }, getChatMember: { body: member } });

  it("accepts a channel where the bot is admin with can_post_messages; normalizes to @username", async () => {
    const calls = setup(docs.chatChannel, docs.memberAdminCanPost);
    expect(await resolvePublishTarget("123:SECRET", "-1001234567890")).toBe("@acme_news");
    expect(calls.find((c) => c.method === "getChatMember")!.body).toEqual({ chat_id: "-1001234567890", user_id: 777000111 });
  });

  it("keeps the numeric id for a channel without a username", async () => {
    setup(docs.chatPrivateChannel, docs.memberAdminCanPost);
    expect(await resolvePublishTarget("123:SECRET", "-1009876543210")).toBe("-1009876543210");
  });

  it("rejects a channel admin without can_post_messages, with the actionable message", async () => {
    setup(docs.chatChannel, docs.memberAdminNoPost);
    await expect(resolvePublishTarget("123:SECRET", "@acme_news")).rejects.toThrow("Add the bot as an administrator of the channel with permission to post messages");
  });

  it("rejects a plain member of a channel, and a bot that left", async () => {
    setup(docs.chatChannel, docs.memberPlain);
    await expect(resolvePublishTarget("123:SECRET", "@acme_news")).rejects.toBeInstanceOf(PermissionError);
    setup(docs.chatGroup, docs.memberLeft);
    await expect(resolvePublishTarget("123:SECRET", "-4000111")).rejects.toBeInstanceOf(PermissionError);
  });

  it("accepts a plain member of a group; rejects a private chat and malformed input", async () => {
    setup(docs.chatGroup, docs.memberPlain);
    expect(await resolvePublishTarget("123:SECRET", "-4000111")).toBe("-4000111");
    setup(docs.chatPrivate, docs.memberPlain);
    await expect(resolvePublishTarget("123:SECRET", "55")).rejects.toBeInstanceOf(PermanentError);
    const calls = stub({});
    await expect(resolvePublishTarget("123:SECRET", "not a chat")).rejects.toBeInstanceOf(PermanentError);
    expect(calls).toEqual([]);
  });

  it("unknown chat -> PermissionError (bot cannot see it)", async () => {
    stub({ getMe: { body: docs.me }, getChat: { status: 400, body: docs.errChatNotFound } });
    await expect(resolvePublishTarget("123:SECRET", "@nope_channel")).rejects.toBeInstanceOf(PermissionError);
  });
});
