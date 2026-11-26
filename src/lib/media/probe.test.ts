import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { defaultProbe } from "./probe";
import { sniffMime } from "./sniff";
import { ApiError } from "@/lib/api/response";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
// "....ftypmp42" — a minimal MP4 box header.
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

describe("sniffMime [PSA12]", () => {
  it("classifies by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(MP4)).toBe("video/mp4");
  });
  it("returns undefined for unrecognized content", () => {
    expect(sniffMime(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("defaultProbe [PSA12]", () => {
  const validPng = () => sharp({ create: { width: 2, height: 3, channels: 3, background: "#fff" } }).png().toBuffer();

  it("rejects an image signature without image data", async () => {
    await expect(defaultProbe(PNG, "image/png")).rejects.toMatchObject({ status: 400 });
  });
  const noisy = (format: "jpeg" | "png" | "webp" | "gif") => sharp({ create: { width: 320, height: 240, channels: 3, background: "#888", noise: { type: "gaussian", mean: 128, sigma: 30 } } })[format]().toBuffer();

  it.each(["jpeg", "png", "webp", "gif"] as const)("rejects a %s with a valid header and cut-off image data", async (format) => {
    const whole = await noisy(format);
    expect(await defaultProbe(whole, `image/${format}`)).toMatchObject({ kind: "image", width: 320, height: 240 });
    await expect(defaultProbe(whole.subarray(0, whole.length >> 1), `image/${format}`)).rejects.toMatchObject({ status: 400, code: "unsupported_media" });
  });

  it("decodes the whole file, not only the sampled prefix", async () => {
    const whole = await noisy("png");
    const directory = await mkdtemp(join(tmpdir(), "probe-test-"));
    try {
      const file = join(directory, "image");
      await writeFile(file, whole);
      expect(await defaultProbe(whole.subarray(0, 1024), "image/png", file)).toMatchObject({ width: 320 });
      await writeFile(file, whole.subarray(0, whole.length >> 1));
      await expect(defaultProbe(whole.subarray(0, 1024), "image/png", file)).rejects.toMatchObject({ status: 400 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts a JPEG with extra bytes after the image", async () => {
    const withTrailer = Buffer.concat([await noisy("jpeg"), Buffer.alloc(100, 7)]);
    expect(await defaultProbe(withTrailer, "image/jpeg")).toMatchObject({ width: 320 });
  });

  it("rejects an image above the pixel limit with a clear message", async () => {
    const huge = await sharp({ create: { width: 12_001, height: 10_000, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(defaultProbe(huge, "image/png")).rejects.toMatchObject({ status: 400, message: "Image exceeds the 120 megapixel limit" });
  });

  it("derives kind + mime from the bytes, not the declared header", async () => {
    expect(await defaultProbe(await validPng(), "image/png")).toMatchObject({ kind: "image", mime: "image/png" });
    expect(await defaultProbe(MP4, "video/mp4")).toMatchObject({ kind: "video", mime: "video/mp4" });
  });

  it("ignores a (lying) declared mime and trusts the sniff when the top-level type agrees", async () => {
    // declared image/jpeg but bytes are PNG → both images → accepted, mime corrected to the truth
    expect(await defaultProbe(await validPng(), "image/jpeg")).toMatchObject({ kind: "image", mime: "image/png" });
  });

  it("rejects content whose declared type contradicts the bytes (content-confusion)", async () => {
    // an MP4 served as image/png → top-level mismatch → rejected
    await expect(defaultProbe(MP4, "image/png")).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects an unrecognized blob even when a media Content-Type is declared", async () => {
    await expect(defaultProbe(new Uint8Array([1, 2, 3, 4]), "image/png")).rejects.toBeInstanceOf(ApiError);
  });
});

it.each(["bytes", "file"])("reads duration and portrait dimensions from a real MP4 %s for format selection", async source => {
  const path = new URL("../../../e2e/fixtures/tiktok-preview.mp4", import.meta.url);
  const bytes = await readFile(path);
  expect(await defaultProbe(bytes, "video/mp4", source === "file" ? fileURLToPath(path) : undefined)).toMatchObject({ durationSec: 1, width: 160, height: 284 });
});
