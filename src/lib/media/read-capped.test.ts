import { describe, it, expect } from "vitest";
import { readBodyCapped } from "./read-capped";
import { ApiError } from "@/lib/api/response";

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      ctrl.close();
    },
  });
  // A streamed Response has no Content-Length (chunked) — exercises the AUD63 path.
  return new Response(stream);
}

describe("readBodyCapped", () => {
  it("returns the bytes when under the cap", async () => {
    const out = await readBodyCapped(streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]), 10);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it("aborts a chunked body that exceeds the cap (no Content-Length)", async () => {
    const big = streamResponse([new Uint8Array(8), new Uint8Array(8)]); // 16 bytes
    await expect(readBodyCapped(big, 10)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects early when Content-Length exceeds the cap", async () => {
    const res = new Response("x", { headers: { "content-length": "999999" } });
    await expect(readBodyCapped(res, 10)).rejects.toBeInstanceOf(ApiError);
  });
});
