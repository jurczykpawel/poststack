import { ApiError } from "@/lib/api/response";

/**
 * Read a fetch Response body into memory with a HARD byte cap, independent of the
 * Content-Length header (AUD44/AUD63): a fast precheck on Content-Length, then a streamed
 * read with a running counter that aborts as soon as the cap is exceeded — so a chunked /
 * header-less response cannot force unbounded buffering.
 */
export async function readBodyCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const cl = Number(res.headers.get("content-length") ?? 0);
  if (cl > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new ApiError("too_large", "Media exceeds ingest cap", 413);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
