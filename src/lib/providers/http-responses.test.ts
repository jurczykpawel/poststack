import { afterEach, describe, expect, it, vi } from "vitest";
import { xProvider } from "./x";
import { linkedinProvider } from "./linkedin";
import { uploadYouTube } from "./youtube-upload";
import { PermissionError, RateLimitedError, PaymentRequiredError } from "./errors";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tokens = { accessToken: "test" };
const args = { tokens, accountId: "123", request: { format: "text" as const, media: [], caption: "hello" }, mediaUrls: [] };

// Envelopes follow docs.x.com/x-api/fundamentals/response-codes-and-errors and
// learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling.
describe("HTTP response classification through providers", () => {
  it("X retains reset headers on the final create request", async () => {
    const reset = Math.ceil(Date.now() / 1000) + 300;
    const fetch = vi.fn(async () => Response.json({ title: "Too Many Requests", type: "about:blank", detail: "Too Many Requests" },
      { status: 429, headers: { "x-rate-limit-reset": String(reset) } }));
    vi.stubGlobal("fetch", fetch);
    const error = await xProvider.publish(args).catch((e: unknown) => e) as RateLimitedError;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.phase).toBe("commit_uncertain");
    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(300);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("X credits failure has an actionable permanent reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 402 })));
    await expect(xProvider.publish(args)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("LinkedIn permission response reaches the delivery with its scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: 403, serviceErrorCode: 100, message: "Not enough permissions: w_member_social" }, { status: 403 })));
    const error = await linkedinProvider.publish(args).catch((e: unknown) => e) as Error;
    expect(error).toBeInstanceOf(PermissionError);
    expect(error.message).toContain("w_member_social");
  });

  it("YouTube resumable status waits for Retry-After before another request", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503, headers: { "retry-after": "360" } }));
    vi.stubGlobal("fetch", fetch);
    const error = await uploadYouTube("https://www.googleapis.com/upload/youtube/v3/videos?upload_id=example", "https://cdn.example/video.mp4", 1, "test", true).catch((e: unknown) => e) as RateLimitedError;
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error.retryAfterSeconds).toBe(360);
    expect(error.phase).toBe("commit_uncertain");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
