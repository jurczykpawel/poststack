import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { notifyChannelDown } from "./channel-alert";

const alert = {
  workspaceId: "ws-1",
  channelId: "ch-1",
  platform: "instagram",
  displayName: "My IG",
  reason: "access token is invalid or expired",
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  delete process.env.CHANNEL_ALERT_WEBHOOK_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("notifyChannelDown", () => {
  it("POSTs an alert payload to the configured webhook", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;

    await notifyChannelDown(alert);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.example/alert");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.event).toBe("channel.needs_reauth");
    expect(body.workspace_id).toBe("ws-1");
    expect(body.channel_id).toBe("ch-1");
    expect(body.reason).toBe("access token is invalid or expired");
  });

  it("is a no-op when no webhook is configured", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;

    await notifyChannelDown(alert);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never throws if the webhook call fails (best-effort)", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as typeof fetch;

    await expect(notifyChannelDown(alert)).resolves.toBeUndefined();
  });

  // a private/link-local target must not be fetched even if it slipped past env
  // validation (e.g. set directly at runtime); the call is skipped, not attempted.
  it("does not fetch a private/link-local target (e.g. cloud metadata)", async () => {
    process.env.CHANNEL_ALERT_WEBHOOK_URL = "http://169.254.169.254/latest/meta-data/";
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch as typeof fetch;

    await notifyChannelDown(alert);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
