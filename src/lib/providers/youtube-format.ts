import type { PublishRequest } from "./types";
import { PermanentError } from "./errors";
import { youtubeProvider } from "./youtube";

type Film = { durationSec: number | null; width: number | null; height: number | null; status?: string };

/** Unknown metadata stays video; auto selection is reconsidered when ingestion finishes. */
export function youtubeFormat(request: PublishRequest, media: Film[]): string {
  if (request.format !== "video" && request.format !== "short") return request.format;
  const cap = youtubeProvider.capabilities().find(c => c.format === "short")!.video!;
  const film = media[0];
  const fits = media.length === 1 && film != null && film.status !== "ingesting" &&
    film.durationSec != null && film.durationSec > 0 && film.durationSec <= cap.maxDurationSec! &&
    film.width != null && film.height != null && film.width > 0 && film.height > 0 &&
    cap.aspectRatios!.some(ratio => {
      const [w, h] = ratio.split(":").map(Number);
      return film.width! * h! === film.height! * w!;
    });
  if (request.options?.youtubeFormatMode === "auto") return fits ? "short" : "video";
  if (request.format === "short" && !fits && film?.status !== "ingesting") {
    throw new PermanentError(`YouTube short requires known duration up to ${cap.maxDurationSec} seconds and ${cap.aspectRatios!.join(" or ")} video; choose video instead`);
  }
  return request.format;
}
