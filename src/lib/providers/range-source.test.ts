import { afterEach, expect, it, vi } from "vitest";
import { sourceRange, sourceSize } from "./range-source";
vi.mock("@/lib/media/ssrf", () => ({ safeFetch: (url: string, init?: RequestInit) => fetch(url, init) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("accepts a 3 GiB storage object by default and preserves an explicit provider size limit", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { headers: { "content-length": String(3 * 1024 ** 3) } })));
  expect(await sourceSize("https://cdn.example/video.mp4")).toBe(3 * 1024 ** 3);
  vi.stubEnv("PROVIDER_DOWNLOAD_MAX_BYTES", "100");
  await expect(sourceSize("https://cdn.example/video.mp4")).rejects.toThrow(/limit/);
});
it("cancels a range response whose declared length exceeds the requested part", async () => {
  let canceled = false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 206, headers: { "content-range": "bytes 0-3/8", "content-length": "5" } })));
  await expect(sourceRange("https://cdn.example/video.mp4", 0, 3, 8)).rejects.toThrow();
  expect(canceled).toBe(true);
});
it("rejects a short or differently addressed range", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2), { status: 206, headers: { "content-range": "bytes 0-3/8" } })));
  await expect(sourceRange("https://cdn.example/video.mp4", 0, 3, 8)).rejects.toThrow(/Incomplete/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(4), { status: 206, headers: { "content-range": "bytes 4-7/8" } })));
  await expect(sourceRange("https://cdn.example/video.mp4", 0, 3, 8)).rejects.toThrow(/range/);
});
it("accepts a full 200 response when the requested range covers the whole object (Backblaze B2)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(8), { status: 200, headers: { "content-length": "8" } })));
  expect((await sourceRange("https://cdn.example/video.mp4", 0, 7, 8)).length).toBe(8);
});
it("still rejects a 200 response for a partial range or a different object size", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(8), { status: 200, headers: { "content-length": "8" } })));
  await expect(sourceRange("https://cdn.example/video.mp4", 0, 3, 8)).rejects.toThrow(/range/);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(9), { status: 200, headers: { "content-length": "9" } })));
  await expect(sourceRange("https://cdn.example/video.mp4", 0, 7, 8)).rejects.toThrow(/range/);
});
