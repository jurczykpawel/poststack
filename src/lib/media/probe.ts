import type { Prober, ProbeResult } from "./service";
import { ApiError } from "@/lib/api/response";
import { videoMetadata } from "./video-metadata";
import { sniffMime } from "./sniff";

const topLevel = (m: string): string => m.split("/")[0]!;

/**
 * Default probe. PSA12: derive `kind` + `mime` from the actual magic bytes, not the attacker-supplied
 * Content-Type, and reject when the declared type contradicts the content (content-confusion). The
 * sniffed mime then drives `casKey`'s object extension + the capability `kinds` gate, so neither can
 * be spoofed by the header.
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
  const kind = sniffed.startsWith("image/") ? "image" : "video";
  return { kind, mime: sniffed, ...(kind === "video" ? await videoMetadata(file ?? bytes) : {}) };
};
