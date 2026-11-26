import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
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

  const solid = (width: number, height: number, channels: 3 | 4 = 3) =>
    sharp({ create: { width, height, channels, background: "#789" }, limitInputPixels: false });

  it("accepts a 108 megapixel baseline JPEG phone photo within the default decode budget", async () => {
    const photo = await solid(12_000, 9_000).jpeg().toBuffer();
    expect(await defaultProbe(photo, "image/jpeg")).toMatchObject({ width: 12_000, height: 9_000 });
  }, 30_000);

  it("rejects an image whose estimated decode memory exceeds the default budget with a clear message", async () => {
    const heavy = await solid(8_165, 6_124, 4).toColourspace("rgb16").png({ progressive: true }).toBuffer();
    await expect(defaultProbe(heavy, "image/png")).rejects.toMatchObject({
      status: 400, code: "unsupported_media", message: "Image is too large to process (50 MP); reduce its resolution",
    });
  }, 30_000);

  // Budget = 128 MiB process reserve + compressed size + pixels × bytes held per pixel.
  it.each([
    ["baseline JPEG", "image/jpeg", 3, () => solid(320, 240).jpeg()],
    ["progressive JPEG", "image/jpeg", 6, () => solid(320, 240).jpeg({ progressive: true })],
    ["progressive CMYK JPEG", "image/jpeg", 8, () => solid(320, 240).toColourspace("cmyk").jpeg({ progressive: true })],
    ["PNG", "image/png", 3, () => solid(320, 240).png()],
    ["interlaced PNG", "image/png", 6, () => solid(320, 240).png({ progressive: true })],
    ["interlaced 16-bit PNG", "image/png", 16, () => solid(320, 240, 4).toColourspace("rgb16").png({ progressive: true })],
    ["opaque WebP", "image/webp", 4, () => solid(320, 240).webp({ lossless: true })],
    ["GIF", "image/gif", 8, () => solid(320, 240).gif()],
  ] as const)("holds a %s to MEDIA_DECODE_MAX_BYTES by its estimated decode memory", async (_name, mime, perPixel, image) => {
    const bytes = await image().toBuffer();
    const needed = 128 * 1024 * 1024 + bytes.length + 320 * 240 * perPixel;
    const directory = await mkdtemp(join(tmpdir(), "probe-test-"));
    try {
      const file = join(directory, "image");
      await writeFile(file, bytes);
      process.env.MEDIA_DECODE_MAX_BYTES = String(needed);
      expect(await defaultProbe(bytes, mime)).toMatchObject({ width: 320, height: 240 });
      expect(await defaultProbe(bytes.subarray(0, 64), mime, file)).toMatchObject({ width: 320 });
      process.env.MEDIA_DECODE_MAX_BYTES = String(needed - 1);
      await expect(defaultProbe(bytes, mime)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("too large to process") });
      await expect(defaultProbe(bytes.subarray(0, 64), mime, file)).rejects.toMatchObject({ status: 400 });
    } finally {
      delete process.env.MEDIA_DECODE_MAX_BYTES;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("falls back to the default budget when MEDIA_DECODE_MAX_BYTES is not a positive integer", async () => {
    process.env.MEDIA_DECODE_MAX_BYTES = "512MB";
    try {
      expect(await defaultProbe(await noisy("png"), "image/png")).toMatchObject({ width: 320 });
    } finally {
      delete process.env.MEDIA_DECODE_MAX_BYTES;
    }
  });

  it("decodes one image at a time per process, also after a failed decode", async () => {
    const images = await Promise.all((["png", "jpeg", "webp", "gif"] as const).map(noisy));
    let active = 0, peak = 0;
    const original = sharp.prototype.toBuffer;
    const spy = vi.spyOn(sharp.prototype, "toBuffer").mockImplementation(async function (this: unknown, ...args: unknown[]) {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 20));
      try { return await (original as (...a: unknown[]) => Promise<Buffer>).apply(this, args); } finally { active -= 1; }
    } as never);
    try {
      const results = await Promise.allSettled([...images, images[0]!.subarray(0, images[0]!.length >> 1)].map((b) => defaultProbe(b, undefined)));
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"]);
      expect(await defaultProbe(images[1]!, undefined)).toMatchObject({ width: 320 });
      expect(peak).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps decoded images out of the libvips operation cache", () => {
    expect(sharp.cache().memory.max).toBe(0);
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
