import sharp from "sharp";
import type { Prober, ProbeResult } from "./service";
import { ApiError } from "@/lib/api/response";
import { videoMetadata } from "./video-metadata";
import { sniffMime } from "./sniff";
import { withDecodeSlot } from "./ingest-limit";

const topLevel = (m: string): string => m.split("/")[0]!;
// A worst-case decode (16-bit RGBA interlaced PNG, CMYK progressive JPEG) holds ~8 bytes per pixel:
// 50 MP peaks at ~450 MiB RSS, inside a 512 MiB budget for the one decode a process runs at a time.
const DEFAULT_DECODE_MAX_PIXELS = 50_000_000;
const decodeMaxPixels = (): number => {
  const configured = Number(process.env.MEDIA_DECODE_MAX_PIXELS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_DECODE_MAX_PIXELS;
};

sharp.cache(false); // decoded uploads are never reused; do not keep them in libvips memory

/**
 * Default probe. PSA12: derive `kind` + `mime` from the actual magic bytes, not the attacker-supplied
 * Content-Type, and reject when the declared type contradicts the content (content-confusion). The
 * sniffed mime then drives `casKey`'s object extension + the capability `kinds` gate, so neither can
 * be spoofed by the header.
 *
 * An image is also decoded once (down to one pixel, the first frame of an animation), so a valid header over
 * cut-off data is refused. Decodes run one at a time per process and are capped at MEDIA_DECODE_MAX_PIXELS.
 *
 * Video duration is rounded up to whole seconds for the media registry. Dimensions are read from the first video stream.
 */
export const defaultProbe: Prober = async (bytes, mime, file): Promise<ProbeResult> => {
  const sniffed = sniffMime(bytes);
  if (!sniffed) {
    throw new ApiError("unsupported_media", "Unrecognized media format (failed magic-byte sniff)", 400);
  }
  if (mime && topLevel(mime) !== topLevel(sniffed)) {
    throw new ApiError("media_type_mismatch", `Declared ${mime} but the content is ${sniffed}`, 400);
  }
  if (sniffed.startsWith("image/")) {
    const maxPixels = decodeMaxPixels();
    const input = file ?? Buffer.from(bytes);
    let width: number, height: number;
    try {
      ({ width, height } = await sharp(input, { limitInputPixels: false }).metadata());
    } catch {
      throw new ApiError("unsupported_media", "Could not read image metadata", 400);
    }
    if (width * height > maxPixels) {
      throw new ApiError("unsupported_media", `Image exceeds the ${maxPixels / 1_000_000} megapixel limit`, 400);
    }
    try {
      await withDecodeSlot(() => sharp(input, { limitInputPixels: maxPixels, failOn: "truncated", sequentialRead: true })
        .resize(1, 1, { fit: "fill" }).raw().toBuffer());
    } catch {
      throw new ApiError("unsupported_media", "Could not decode the image: the file is damaged or incomplete", 400);
    }
    return { kind: "image", mime: sniffed, width, height };
  }
  return { kind: "video", mime: sniffed, ...await videoMetadata(file ?? bytes) };
};
