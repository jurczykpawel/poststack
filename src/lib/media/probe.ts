import sharp, { type Metadata } from "sharp";
import { stat } from "node:fs/promises";
import type { Prober, ProbeResult } from "./service";
import { ApiError } from "@/lib/api/response";
import { videoMetadata } from "./video-metadata";
import { sniffMime } from "./sniff";
import { withDecodeSlot } from "./ingest-limit";

const topLevel = (m: string): string => m.split("/")[0]!;
const DEFAULT_DECODE_MAX_BYTES = 512 * 1024 * 1024;
const PROCESS_RESERVE_BYTES = 128 * 1024 * 1024;
const decodeMaxBytes = (): number => {
  const configured = Number(process.env.MEDIA_DECODE_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_DECODE_MAX_BYTES;
};

// Upper estimate of peak RSS; multi-scan JPEG reports as progressive, and GIF peaks near 5 bytes per pixel.
const decodeBytes = ({ format, width, height, channels, depth, isProgressive }: Metadata, fileBytes: number): number => {
  const bands = format === "webp" || format === "gif" ? 4 : channels;
  const bytesPerSample = depth === "uchar" ? 1 : 2;
  const passes = isProgressive || format === "gif" ? 2 : 1;
  return PROCESS_RESERVE_BYTES + fileBytes + width * height * bands * bytesPerSample * passes;
};

sharp.cache(false); // decoded uploads are never reused; do not keep them in libvips memory

/**
 * Default probe. PSA12: derive `kind` + `mime` from the actual magic bytes, not the attacker-supplied
 * Content-Type, and reject when the declared type contradicts the content (content-confusion). The
 * sniffed mime then drives `casKey`'s object extension + the capability `kinds` gate, so neither can
 * be spoofed by the header.
 *
 * An image is also decoded once (down to one pixel, the first frame of an animation), so a valid header over
 * cut-off data is refused. Decodes run one at a time per process, and only when their estimated memory fits
 * MEDIA_DECODE_MAX_BYTES.
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
    const input = file ?? Buffer.from(bytes);
    let metadata: Metadata;
    try {
      metadata = await sharp(input, { limitInputPixels: false }).metadata();
    } catch {
      throw new ApiError("unsupported_media", "Could not read image metadata", 400);
    }
    const { width, height } = metadata;
    if (decodeBytes(metadata, file ? (await stat(file)).size : bytes.length) > decodeMaxBytes()) {
      const megapixels = Math.round((width * height) / 1_000_000);
      throw new ApiError("unsupported_media", `Image is too large to process (${megapixels} MP); reduce its resolution`, 400);
    }
    try {
      await withDecodeSlot(() => sharp(input, { limitInputPixels: false, failOn: "truncated", sequentialRead: true })
        .resize(1, 1, { fit: "fill" }).raw().toBuffer());
    } catch {
      throw new ApiError("unsupported_media", "Could not decode the image: the file is damaged or incomplete", 400);
    }
    return { kind: "image", mime: sniffed, width, height };
  }
  return { kind: "video", mime: sniffed, ...await videoMetadata(file ?? bytes) };
};
