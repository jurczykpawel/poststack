import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// rateLimit is mocked so the throttle is deterministic without a DB.
const rateLimit = vi.fn();
vi.mock("@/lib/api/rate-limit", () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));

import { dispatchAlert } from "./alert";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
  rateLimit.mockResolvedValue({ allowed: true }); // not throttled by default
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("dispatchAlert", () => {
  it("POSTs the alert with its type discriminator to the configured webhook", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;

    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1", workspaceId: "ws-1", detail: "boom" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example/alert");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.type).toBe("delivery_failed");
    expect(body.channel_id).toBe("ch-1");
    expect(body.detail).toBe("boom");
  });

  it("is a no-op when no webhook is configured", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
    await dispatchAlert({ type: "event_error", detail: "x" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("suppresses a duplicate (same type+channel) within the throttle window", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;
    // First passes (allowed), second is throttled (not allowed).
    rateLimit.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({ allowed: false });

    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1" });
    await dispatchAlert({ type: "delivery_failed", channelId: "ch-1" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    // the throttle key is scoped by type + channel.
    expect(rateLimit).toHaveBeenCalledWith("alert:delivery_failed:ch-1", 1, expect.any(Number));
  });

  it("never throws if the webhook call fails (best-effort)", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch;
    await expect(dispatchAlert({ type: "channel_reauth", channelId: "ch-1" })).resolves.toBeUndefined();
  });

  it("does not fetch a private/link-local target (e.g. cloud metadata)", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://169.254.169.254/latest/meta-data/";
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;
    await dispatchAlert({ type: "event_error" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails open (still alerts) when the throttle store errors", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;
    rateLimit.mockRejectedValue(new Error("db down"));
    await dispatchAlert({ type: "delivery_held", channelId: "ch-1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
