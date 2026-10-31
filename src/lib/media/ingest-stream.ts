import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "@/lib/api/response";
import type { Storage } from "@/lib/storage/types";
import { mediaMaxBytes } from "./read-capped";

class IngestError extends ApiError {}

export async function ingestStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (cause) {
    if (cause instanceof IngestError) throw cause;
    const error = new IngestError(cause instanceof ApiError ? cause.code : "ingest_failed",
      `${stage}: ${cause instanceof Error ? cause.message : "Media ingest failed"}`, cause instanceof ApiError ? cause.status : 400);
    error.cause = cause;
    throw error;
  }
}

export async function ingestStream<T>(res: Response, storage: Storage, use: (input: { checksum: string; size: number; prefix: Uint8Array; file: string; temporary: string }) => Promise<T>): Promise<T> {
  const max = mediaMaxBytes();
  const reader = res.body?.getReader();
  const temporary = `media/tmp/${randomUUID()}`;
  let directory: string | undefined, output: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256"), prefix = new Uint8Array(64 * 1024);
  let size = 0, sampled = 0;
  async function download() {
    if (!reader || !Number.isFinite(max) || max <= 0 || Number(res.headers.get("content-length")) > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);
    for (;;) {
      const { done, value } = await ingestStage("download", () => reader.read());
      if (done) break;
      size += value.length;
      if (size > max) throw new ApiError("too_large", "Media exceeds ingest cap", 413);
      const sample = value.subarray(0, prefix.length - sampled); prefix.set(sample, sampled); sampled += sample.length;
      await ingestStage("hash", async () => { hash.update(value); });
      await ingestStage("temp", () => output!.writeFile(value));
    }
  }
  let failed = false;
  try {
    directory = await ingestStage("temp", () => mkdtemp(join(tmpdir(), "poststack-ingest-")));
    const file = join(directory, "media");
    output = await ingestStage("temp", () => open(file, "w"));
    // Finish the source before slow multipart writes can hold its connection idle.
    await download();
    await ingestStage("upload", async () => {
      const source = createReadStream(file);
      try { await storage.putStream(temporary, source, "application/octet-stream"); }
      finally { source.destroy(); }
    });
    const checksum = await ingestStage("hash", async () => hash.digest("hex"));
    return await use({ checksum, size, prefix: prefix.subarray(0, sampled), file, temporary });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
    await Promise.allSettled([
      ingestStage("temp", async () => { await output?.close(); if (directory) await rm(directory, { recursive: true, force: true }); }),
      ingestStage("upload", () => storage.delete(temporary)),
    ]).then(results => {
      if (!failed) for (const result of results) if (result.status === "rejected") throw result.reason;
    });
  }
}
