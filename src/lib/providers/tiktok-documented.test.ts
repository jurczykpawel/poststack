import { afterEach, describe, expect, it, vi } from "vitest";
import docs from "../../../tests/fixtures/provider-docs/tiktok.json";
import { tiktokProvider } from "./tiktok";
import { ConfirmationRequiredError, PermanentError, RateLimitedError, TokenInvalidError, TransientError } from "./errors";

vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (url: string, init?: RequestInit) => fetch(url, init) }));
afterEach(() => { vi.unstubAllGlobals(); });

const source = "https://cdn.example/video.mp4";
const args = { tokens: { accessToken: "test" }, accountId: "creator", request: { format: "video" as const, media: [] }, mediaUrls: [source] };
const reply = ({ status, body }: { status: number; body: unknown }) => Response.json(body, { status });

function server(init: { status: number; body: unknown }, uploadStatus = docs.upload.complete) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url === source && options?.method === "HEAD") return new Response(null, { headers: { "content-length": "8" } });
    if (url === source) return new Response(new Uint8Array(8), { status: 206, headers: { "content-range": "bytes 0-7/8", "content-length": "8" } });
    if (url.includes("/video/init/")) return reply(init);
    return new Response(null, { status: uploadStatus });
  }));
}

describe("TikTok init errors as documented", () => {
  it.each([["urlOwnershipUnverified"], ["unauditedClient"]] as const)("%s fails the post without asking to reconnect a healthy channel", async (name) => {
    server(docs.init[name]);
    const failure = await tiktokProvider.publish(args).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(PermanentError);
    expect(failure).not.toBeInstanceOf(TokenInvalidError);
  });
  it.each([["privacyMismatch"], ["spamRisk"]] as const)("%s asks the creator to review the post again", async (name) => {
    server(docs.init[name]);
    await expect(tiktokProvider.publish(args)).rejects.toBeInstanceOf(ConfirmationRequiredError);
  });
  it("an invalid token asks to reconnect", async () => {
    server(docs.init.tokenInvalid);
    await expect(tiktokProvider.publish(args)).rejects.toBeInstanceOf(TokenInvalidError);
  });
  it("a rate limit waits and retries because no post exists yet", async () => {
    server(docs.init.rateLimited);
    await expect(tiktokProvider.publish(args)).rejects.toMatchObject({ kind: "rate_limited", phase: "pre_commit" });
    await expect(tiktokProvider.publish(args)).rejects.toBeInstanceOf(RateLimitedError);
  });
  it("treats the request as successful only when error.code is ok", async () => {
    server({ status: 200, body: { data: docs.init.ok.body.data, error: { code: "internal_error", message: "", log_id: "example" } } });
    await expect(tiktokProvider.publish(args)).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("TikTok chunk upload responses as documented", () => {
  it("accepts the documented final 201", async () => {
    server(docs.init.ok);
    await expect(tiktokProvider.publish(args)).resolves.toEqual({ providerHandle: docs.init.ok.body.data.publish_id, processing: true });
  });
  it("an expired upload URL restarts the upload and leaves the channel connected", async () => {
    server(docs.init.ok, docs.upload.urlExpired);
    const failure = await tiktokProvider.publish(args).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransientError);
    expect(failure).toMatchObject({ phase: "pre_commit" });
  });
});

describe("TikTok status responses as documented", () => {
  const status = (response: { status: number; body: unknown }) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(response)));
    return tiktokProvider.publishStatus!({ accessToken: "test" }, { providerHandle: "id" });
  };
  it("reports the provider's failure reason", async () => {
    await expect(status(docs.status.failed)).resolves.toEqual({ state: "failed", error: "picture_size_check_failed" });
  });
  it("reports completion with the provider's post id list present", async () => {
    await expect(status(docs.status.complete)).resolves.toEqual({ state: "published", postId: "7300000000000000000" });
  });
  it("classifies an unknown publish id, an invalid token and a rate limit distinctly", async () => {
    await expect(status(docs.status.invalidPublishId)).rejects.toBeInstanceOf(PermanentError);
    await expect(status(docs.status.tokenInvalid)).rejects.toBeInstanceOf(TokenInvalidError);
    await expect(status(docs.status.rateLimited)).rejects.toBeInstanceOf(RateLimitedError);
  });
});
