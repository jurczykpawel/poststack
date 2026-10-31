import { mediaMaxBytes } from "@/lib/media/read-capped";
import { safeFetch } from "@/lib/media/ssrf";
import { readProviderBody } from "./download";
import { PermanentError } from "./errors";
import { classifyHttp } from "./http";

export const UPLOAD_CHUNK = 16 * 1024 * 1024;

export async function sourceSize(url: string, max = Number(process.env.PROVIDER_DOWNLOAD_MAX_BYTES ?? mediaMaxBytes())): Promise<number> {
  const res = await safeFetch(url, { method: "HEAD" });
  await res.body?.cancel();
  if (!res.ok) throw classifyHttp(res.status, "Cannot read media size", "pre_commit");
  const size = Number(res.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0 || size > max || !Number.isFinite(max) || max <= 0) throw new PermanentError("Media size unavailable or exceeds upload limit");
  return size;
}

export async function sourceRange(url: string, first: number, last: number, size: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first || last >= size || last - first >= 2 * UPLOAD_CHUNK) throw new PermanentError("Invalid media range");
  const res = await safeFetch(url, { headers: { range: `bytes=${first}-${last}`, "accept-encoding": "identity" } });
  // Backblaze B2 answers a range covering the whole object with a plain 200 and no Content-Range.
  const wholeObject = res.status === 200 && first === 0 && last === size - 1 && res.headers.get("content-length") === String(size);
  if (!wholeObject && (res.status !== 206 || res.headers.get("content-range") !== `bytes ${first}-${last}/${size}`)) {
    await res.body?.cancel();
    throw new PermanentError("Storage did not return the requested media range");
  }
  const bytes = await readProviderBody(res, last - first + 1);
  if (bytes.length !== last - first + 1) throw new PermanentError("Incomplete media range");
  return bytes;
}
