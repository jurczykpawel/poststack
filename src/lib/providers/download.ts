import { readBodyCapped } from "@/lib/media/read-capped";
import { ApiError } from "@/lib/api/response";
import { PermanentError } from "./errors";

// PSA52: provider-side downloads (re-fetching the stored media / a cover before upload) must not
// buffer an unbounded body into the worker's memory. Caps are env-overridable and read per-call.
const downloadMax = (): number => Number(process.env.PROVIDER_DOWNLOAD_MAX_BYTES ?? 256 * 1024 * 1024);
const coverMax = (): number => Number(process.env.PROVIDER_COVER_MAX_BYTES ?? 16 * 1024 * 1024);

/**
 * Read a provider download into memory with a HARD streaming size cap (PSA52, reusing the AUD44/63
 * `readBodyCapped` helper — the limit is enforced *during* the read, not after). A too-large body is
 * permanent (it won't shrink on retry), so it surfaces as PermanentError and the worker fails cleanly.
 */
export async function readProviderBody(res: Response, max = downloadMax()): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readBodyCapped(res, max);
  } catch (err) {
    if (err instanceof ApiError) {
      throw new PermanentError(`provider download exceeds the ${Math.round(max / (1024 * 1024))}MB cap`);
    }
    throw err;
  }
}

/** A cover/thumbnail download — small media, so a tighter cap (PSA52). */
export async function readProviderCover(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  return readProviderBody(res, coverMax());
}
