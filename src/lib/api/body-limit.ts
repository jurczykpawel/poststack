/**
 * Parse JSON request body with size limit.
 * Returns parsed object or null on failure (oversized, malformed, empty).
 */
export async function parseJsonBody(
  request: Request,
  maxBytes = 16_384
): Promise<unknown | null> {
  // Fast check via Content-Length header (can be spoofed but cheap)
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    return null;
  }

  // Stream-based size check (the real guard)
  const reader = request.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) return null;

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) return null;

  const decoder = new TextDecoder();
  const text = chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
