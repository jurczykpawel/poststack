import { describe, it, expect, vi } from "vitest";
import { runSmoke } from "./live-x-smoke";

const env = { TEST_BASE_URL: "https://test.example", LIVE_X_API_KEY: "fixture-key", LIVE_X_CHANNEL_ID: "channel" };
function fixture(status = "sent") {
  let deleted = false;
  const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
    const data = input.endsWith("/platform") ? (init?.method === "DELETE" ? (deleted = true, { deleted: true }) : { exists: !deleted, providerStatus: deleted ? 404 : 200, platformPostId: "123" })
      : input.endsWith("/publish") ? {} : init?.method === "POST" ? { id: "post" }
      : { delivery: { id: "delivery", status, platformPostId: "123" }, publishedUrl: "https://x.com/i/web/status/123" };
    return Response.json({ data, error: null });
  });
  return fetcher;
}
describe("live X smoke", () => {
  it("skips without configuration and makes no requests", async () => {
    const fetcher = fixture();
    expect(await runSmoke({}, fetcher)).toContain("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("publishes once without links, reads and deletes the platform post", async () => {
    const fetcher = fixture();
    expect(await runSmoke(env, fetcher)).toContain("PASS");
    const create = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(create).toMatchObject({ platform: "twitter", firstComment: "", autoStory: false });
    expect(create.description).toMatch(/^PostStack live X smoke \d{4}-/);
    expect(create.description).not.toMatch(/https?:/);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("/platform");
  });
  it("times out and cancels pending delivery", async () => {
    const fetcher = fixture("scheduled");
    await expect(runSmoke(env, fetcher, 0)).rejects.toThrow("delivery timeout");
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/cancel"))).toBe(true);
  });
  it.each([402, 429])("reports HTTP %i without retrying publish or logging response", async (status) => {
    const fetcher = vi.fn(async () => Response.json({ secret: "private" }, { status }));
    await expect(runSmoke(env, fetcher)).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([402, 429])("fails on an X delivery error %i without a second publish", async (code) => {
    const base = fixture();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/post")
      ? Response.json({ data: { delivery: { id: "delivery", status: "failed", lastError: `X HTTP ${code}` } } }) : base(url, init));
    await expect(runSmoke(env, fetcher)).rejects.toThrow("Delivery failed");
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/publish"))).toHaveLength(1);
  });
  it("rejects an unconfirmed deletion", async () => {
    const base = fixture();
    const fetcher = async (url: string, init?: RequestInit) => url.endsWith("/platform") && init?.method === "DELETE"
      ? Response.json({ data: { deleted: false } }) : base(url, init);
    await expect(runSmoke(env, fetcher)).rejects.toThrow("Deletion not acknowledged");
  });
  it("cleans up even if the sent URL is invalid", async () => {
    const base = fixture();
    const fetcher = async (url: string, init?: RequestInit) => url.endsWith("/post") ? Response.json({ data: { delivery: { status: "sent", platformPostId: "123" }, publishedUrl: "https://wrong.example" } }) : base(url, init);
    await expect(runSmoke(env, fetcher)).rejects.toThrow("sent ID/URL");
    expect(base.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});
