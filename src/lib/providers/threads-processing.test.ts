import { afterEach, describe, expect, it, vi } from "vitest";
import { threadsProvider as provider } from "./threads";
import type { PublishHandle } from "./types";

const tokens = { accessToken: "fixture" };
afterEach(() => vi.unstubAllGlobals());
// Container status examples and states: Meta's official Threads Postman collection,
// https://github.com/fbsamples/threads_api/blob/main/postman/threads-api.postman_collection.json
async function start(format = "video", count = 1) {
  return provider.publish({ tokens, accountId: "123", request: { format, media: [], caption: "hello" }, mediaUrls: Array.from({ length: count }, (_, i) => `https://cdn.example/${i}`), mediaKinds: Array.from({ length: count }, (_, i) => i % 2 ? "video" : "image") });
}
function fixture(status = "FINISHED") {
  let n = 0;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("threads_publish")) return Response.json({ id: "987" });
    if (init?.method === "POST") return Response.json({ id: String(++n) });
    return Response.json({ id: "1", status, ...(status === "ERROR" ? { error_message: "FAILED_DOWNLOADING_VIDEO" } : {}) });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function poll(handle: PublishHandle, saved: string[] = []) {
  return provider.publishStatus!(tokens, handle, async value => { saved.push(value); handle.providerHandle = value; });
}
describe("Threads container workflow", () => {
  it("defers initialization until a durable processing handle exists", async () => {
    const fetcher = fixture();
    expect(await start()).toMatchObject({ processing: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("waits for single video readiness and publishes exactly once", async () => {
    const fetcher = fixture("IN_PROGRESS");
    const handle = await start();
    await poll(handle);
    expect(await poll(handle)).toMatchObject({ state: "accepted" });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("threads_publish"))).toHaveLength(0);
    fixture();
    expect(await poll(handle)).toMatchObject({ state: "published", postId: "987" });
    const noFetch = fixture();
    expect(await poll(handle)).toMatchObject({ state: "published", postId: "987" });
    expect(noFetch).not.toHaveBeenCalled();
  });
  it.each(["ERROR", "EXPIRED"])("fails terminal %s containers with a useful reason", async status => {
    fixture(status);
    const handle = await start();
    await poll(handle);
    expect(await poll(handle)).toMatchObject({ state: "failed", error: expect.stringContaining(status === "ERROR" ? "FAILED_DOWNLOADING_VIDEO" : "EXPIRED") });
  });
  it("creates mixed children in order and a parent only after children finish", async () => {
    const fetcher = fixture();
    const handle = await start("carousel", 2);
    await poll(handle);
    await poll(handle);
    expect(await poll(handle)).toMatchObject({ state: "published", postId: "987" });
    const bodies = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => new URLSearchParams(init!.body as URLSearchParams));
    expect(bodies.map(b => b.get("media_type"))).toEqual(["IMAGE", "VIDEO", "CAROUSEL", null]);
    expect(bodies[0].get("is_carousel_item")).toBe("true");
    expect(bodies[1].get("video_url")).toBe("https://cdn.example/1");
    expect(bodies[2].get("children")).toBe("1,2");
  });
  it.each([1, 21])("rejects %s carousel media before creating containers", async count => {
    const fetcher = fixture();
    await expect(start("carousel", count)).rejects.toThrow("2–20");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never repeats publish after a timeout, including when status remains FINISHED", async () => {
    fixture(); const handle = await start(); await poll(handle);
    const fetcher = fixture();
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error("timeout");
      return Response.json({ status: "FINISHED" });
    });
    await expect(poll(handle)).rejects.toThrow("timeout");
    const retry = fixture();
    expect(await poll(handle)).toMatchObject({ state: "accepted" });
    expect(retry.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    fixture("PUBLISHED");
    expect(await poll(handle)).toMatchObject({ state: "published" });
  });
  it("does not repeat a container create interrupted after its checkpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const handle = await start();
    await expect(poll(handle)).rejects.toThrow("timeout");
    const retry = fixture();
    expect(await poll(handle)).toMatchObject({ state: "failed" });
    expect(retry).not.toHaveBeenCalled();
  });
});

it("waits for all children without creating a parent or new children", async () => {
  const fetcher = fixture("IN_PROGRESS");
  const handle = await start("carousel", 2);
  await poll(handle);
  await poll(handle);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  const ready = fixture();
  await poll(handle);
  expect(ready.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  expect(new URLSearchParams(ready.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as URLSearchParams).get("media_type")).toBe("CAROUSEL");
});
it.each(["text", "image"])("checks readiness before publishing %s", async format => {
  const fetcher = fixture();
  const handle = await start(format, format === "text" ? 0 : 1);
  await poll(handle);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("threads_publish"))).toBe(false);
  expect(await poll(handle)).toMatchObject({ state: "published" });
});
it("publishes the documented maximum of twenty mixed children", async () => {
  const fetcher = fixture();
  const handle = await start("carousel", 20);
  await poll(handle);
  expect(await poll(handle)).toMatchObject({ state: "published" });
  const bodies = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => new URLSearchParams(init!.body as URLSearchParams));
  expect(bodies.filter(body => body.get("is_carousel_item") === "true")).toHaveLength(20);
  expect(bodies.find(body => body.get("media_type") === "CAROUSEL")!.get("children")!.split(",")).toHaveLength(20);
});
it("does not mutate if the durable checkpoint could not be saved", async () => {
  const fetcher = fixture(); const handle = await start();
  await expect(provider.publishStatus!(tokens, handle, async () => { throw new Error("checkpoint unavailable"); })).rejects.toThrow("checkpoint unavailable");
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not publish when another poll has claimed finalization", async () => {
  fixture(); const handle = await start(); await poll(handle);
  const fetcher = fixture();
  await expect(provider.publishStatus!(tokens, handle, async () => { throw new Error("checkpoint changed"); })).rejects.toThrow("checkpoint changed");
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
