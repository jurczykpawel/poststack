import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { prepareStoryMedia, resolveAutoStoryMode } from "./media";

const { getMedia, safeFetch } = vi.hoisted(() => ({ getMedia: vi.fn(), safeFetch: vi.fn() }));
vi.mock("@/lib/media/service", () => ({ getMedia }));
vi.mock("@/lib/media/ssrf", () => ({ safeFetch }));
const request = { format: "carousel", media: [{ mediaId: "first" }, { mediaId: "second" }] };
let video: Buffer;
let pcmVideo: Buffer;
let jpeg: Buffer;
beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "story-test-"));
  try {
    const file = join(directory, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=540x960:r=24", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", file]);
    video = readFileSync(file);
    const audioFile = join(directory, "pcm.mov");
    execFileSync("ffmpeg", ["-v", "error", "-i", file, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "copy", "-c:a", "pcm_s16le", audioFile]);
    pcmVideo = readFileSync(audioFile);
    jpeg = await sharp({ create: { width: 540, height: 960, channels: 3, background: "red" } }).jpeg().toBuffer();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
afterEach(() => vi.resetAllMocks());
function asset(kind: "image" | "video", bytes: Uint8Array) {
  getMedia.mockResolvedValue({ kind, url: "https://cdn.example/asset", status: "ready" });
  safeFetch.mockImplementation(async () => new Response(new Uint8Array(bytes)));
}

describe("auto-Story media", () => {
  it("resolves post, channel and built-in defaults", () => {
    expect(resolveAutoStoryMode("card", "media")).toBe("card");
    expect(resolveAutoStoryMode(null, "media")).toBe("media");
    expect(resolveAutoStoryMode()).toBe("card");
  });
  it.each(["image", "video"] as const)("uses the first %s from a carousel", async kind => {
    asset(kind, kind === "image" ? jpeg : video);
    expect(await prepareStoryMedia(request, "ws", "instagram", "media")).toMatchObject({ mediaUrl: "https://cdn.example/asset", mediaKind: kind });
    expect(getMedia).toHaveBeenCalledExactlyOnceWith("first", "ws");
  });
  it("extracts a real video frame for the generated card", async () => {
    asset("video", video);
    const result = await prepareStoryMedia(request, "ws", "facebook", "card");
    expect((await sharp(result.thumbnail).metadata()).format).toBe("jpeg");
    expect(result.mediaUrl).toBeUndefined();
  });
  it("falls back with a reason for a video over 60 seconds", async () => {
    asset("video", video);
    getMedia.mockResolvedValue({ kind: "video", url: "https://cdn.example/asset", duration_sec: 61, status: "ready" });
    const result = await prepareStoryMedia(request, "ws", "instagram", "media");
    expect(result.fallbackReason).toBe("video_duration");
    expect(result.mediaUrl).toBeUndefined();
    expect(result.thumbnail).toBeDefined();
  });
  it.each([[75, false], [91, true]] as const)("Facebook accepts Story video up to 90 s (%s s → fallback %s)", async (seconds, falls) => {
    asset("video", video);
    getMedia.mockResolvedValue({ kind: "video", url: "https://cdn.example/asset", duration_sec: seconds, status: "ready" });
    const result = await prepareStoryMedia(request, "ws", "facebook", "media");
    expect(result.fallbackReason === "video_duration").toBe(falls);
  });
  it("falls back on an unsupported image format", async () => {
    asset("image", await sharp(jpeg).png().toBuffer());
    expect((await prepareStoryMedia(request, "ws", "instagram", "media")).fallbackReason).toBe("image_format");
  });
  it("uses a card for video with unsupported audio", async () => {
    asset("video", pcmVideo);
    const result = await prepareStoryMedia(request, "ws", "instagram", "media");
    expect(result.fallbackReason).toBe("video_audio");
    expect(result.thumbnail).toBeDefined();
  });
  it("falls back for missing media", async () => {
    expect((await prepareStoryMedia({ ...request, media: [] }, "ws", "instagram", "media")).fallbackReason).toBe("missing_media");
  });
  it("retains an oversized image as the fallback card thumbnail", async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes.set(jpeg);
    asset("image", bytes);
    const result = await prepareStoryMedia(request, "ws", "instagram", "media");
    expect(result.fallbackReason).toBe("image_size");
    expect(result.thumbnail).toEqual(bytes);
  });
  it("caps streamed input without a content-length", async () => {
    asset("image", jpeg);
    safeFetch.mockResolvedValue(new Response(new Uint8Array(17 * 1024 * 1024)));
    expect((await prepareStoryMedia(request, "ws", "instagram", "media")).fallbackReason).toBe("media_size");
  });
});
