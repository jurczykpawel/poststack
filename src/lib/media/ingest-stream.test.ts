import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ingestStream } from "./ingest-stream";
import { safeFetch } from "@/lib/net/safe-fetch";
import { InMemoryStorage } from "@/lib/storage/memory";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("stream ingestion lifecycle", () => {
  it("finishes two concurrent downloads with repeated slow storage writes and source idle limits", async () => {
    const total = 32 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 7);
    const expectedHash = createHash("sha256");
    for (let n = 0; n < total; n += chunk.length) expectedHash.update(chunk);
    const checksum = expectedHash.digest("hex");
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": total });
      res.setTimeout(100, () => res.destroy());
      let sent = 0;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once("drain", pump); return; }
        }
        res.end();
      };
      pump();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const results = await Promise.allSettled([0, 1].map(async () => {
        const storage = new InMemoryStorage("https://cdn.example");
        let stored = 0, pauses = 0;
        const hash = createHash("sha256");
        vi.spyOn(storage, "putStream").mockImplementation(async (_key, chunks) => {
          for await (const value of chunks) {
            stored += value.length; hash.update(value);
            if (stored >= (pauses + 1) * 8 * 1024 * 1024 && pauses < 3) {
              pauses++;
              await new Promise(resolve => setTimeout(resolve, 250));
            }
          }
        });
        const response = await safeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, {}, {
          allow: new Set(["loopback"]), stream: true,
        });
        await ingestStream(response, storage, async input => {
          expect(input.size).toBe(total);
          expect(input.checksum).toBe(checksum);
          expect((await stat(input.file)).size).toBe(total);
        });
        expect(pauses).toBe(3);
        expect(stored).toBe(total);
        expect(hash.digest("hex")).toBe(checksum);
      }));
      expect(results).toEqual([expect.objectContaining({ status: "fulfilled" }), expect.objectContaining({ status: "fulfilled" })]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it("identifies a failed download and removes temporary storage", async () => {
    const source = new ReadableStream({ pull(controller) { controller.error(new Error("aborted")); } });
    const storage = new InMemoryStorage("https://cdn.example");
    const remove = vi.spyOn(storage, "delete");
    await expect(ingestStream(new Response(source), storage, async () => {})).rejects.toThrow("download: aborted");
    expect(remove).toHaveBeenCalledOnce();
  });
  it("identifies a failed upload after completing the download", async () => {
    let downloaded = false;
    const source = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1)); controller.close(); downloaded = true; } });
    const storage = new InMemoryStorage("https://cdn.example");
    vi.spyOn(storage, "putStream").mockRejectedValue(new Error("S3 multipart part failed"));
    await expect(ingestStream(new Response(source), storage, async () => {})).rejects.toThrow("upload: S3 multipart part failed");
    expect(downloaded).toBe(true);
  });
  it("preserves the download reason when temporary storage cleanup also fails", async () => {
    const source = new ReadableStream({ pull(controller) { controller.error(new Error("aborted")); } });
    const storage = new InMemoryStorage("https://cdn.example");
    vi.spyOn(storage, "delete").mockRejectedValue(new Error("S3 delete failed"));
    await expect(ingestStream(new Response(source), storage, async () => {})).rejects.toThrow("download: aborted");
  });
  it("identifies temporary-file failures and cancels the download even before opening a file", async () => {
    let canceled = false;
    const source = new ReadableStream({ cancel() { canceled = true; } });
    vi.stubEnv("TMPDIR", "/dev/null");
    await expect(ingestStream(new Response(source), new InMemoryStorage("https://cdn.example"), async () => {})).rejects.toThrow("temp: ENOTDIR");
    expect(canceled).toBe(true);
  });
  it("hashes exact streamed bytes and supplies a full disk file with only a bounded prefix", async () => {
    const bytes = new Uint8Array(256 * 1024).fill(7);
    const storage = new InMemoryStorage("https://cdn.example");
    let file = "", temporary = "";
    await ingestStream(new Response(bytes), storage, async input => {
      file = input.file; temporary = input.temporary;
      expect(input.size).toBe(bytes.length);
      expect(input.prefix.length).toBe(64 * 1024);
      expect(input.checksum).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(await readFile(input.file)).toEqual(Buffer.from(bytes));
      expect((await storage.head(input.temporary)).size).toBe(bytes.length);
    });
    await expect(stat(file)).rejects.toThrow();
    expect((await storage.head(temporary)).exists).toBe(false);
  });
  it("enforces the actual streamed byte limit without Content-Length and cancels the source", async () => {
    vi.stubEnv("MEDIA_MAX_BYTES", "4");
    let canceled = false;
    const res = new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(3)); }, cancel() { canceled = true; } }));
    const storage = new InMemoryStorage("https://cdn.example");
    const remove = vi.spyOn(storage, "delete");
    await expect(ingestStream(res, storage, async () => {})).rejects.toMatchObject({ code: "too_large", status: 413 });
    expect(canceled).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  });
  it("removes both temporary copies when metadata probing rejects", async () => {
    const storage = new InMemoryStorage("https://cdn.example");
    let file = "", temporary = "";
    await expect(ingestStream(new Response(new Uint8Array([1])), storage, async input => {
      file = input.file; temporary = input.temporary; throw new Error("Unsupported video");
    })).rejects.toThrow("Unsupported video");
    await expect(stat(file)).rejects.toThrow();
    expect((await storage.head(temporary)).exists).toBe(false);
  });
});
