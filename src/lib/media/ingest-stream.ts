import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@/lib/api/response";
import type { Storage } from "@/lib/storage/types";
import { mediaMaxBytes } from "./read-capped";

export async function ingestStream<T>(res: Response, storage: Storage, use: (input: { checksum: string; size: number; prefix: Uint8Array; file: string; temporary: string }) => Promise<T>): Promise<T> {
  const max = mediaMaxBytes();
  const reader = res.body?.getReader();
  const directory = await mkdtemp(join(tmpdir(), "poststack-ingest-"));
  const file = join(directory, "media"), temporary = `media/tmp/${randomUUID()}`;
  const output = await open(file, "w");
  const hash = createHash("sha256"), prefix = new Uint8Array(64 * 1024);
  let size = 0, sampled = 0;
  async function* chunks() {
    if (!reader || !Number.isFinite(max) || max <= 0 || Number(res.headers.get("content-length")) > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);
      const sample = value.subarray(0, prefix.length - sampled); prefix.set(sample, sampled); sampled += sample.length;
      hash.update(value);
      await output.writeFile(value);
      yield value;
    }
  }
  try {
    await storage.putStream(temporary, chunks(), "application/octet-stream");
    return await use({ checksum: hash.digest("hex"), size, prefix: prefix.subarray(0, sampled), file, temporary });
  } finally {
    await reader?.cancel().catch(() => {});
    await Promise.all([output.close(), rm(directory, { recursive: true, force: true }), storage.delete(temporary)]);
  }
}
