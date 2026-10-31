import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { ingestStream } from "./ingest-stream";
import { InMemoryStorage } from "@/lib/storage/memory";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("stream ingestion lifecycle", () => {
  it("identifies a failed download and removes temporary storage", async () => {
    const source = new ReadableStream({ pull(controller) { controller.error(new Error("aborted")); } });
    const storage = new InMemoryStorage("https://cdn.example");
    const remove = vi.spyOn(storage, "delete");
    await expect(ingestStream(new Response(source), storage, async () => {})).rejects.toThrow("download: aborted");
    expect(remove).toHaveBeenCalledOnce();
  });
  it("identifies a failed upload and cancels the download", async () => {
    let canceled = false;
    const source = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1)); }, cancel() { canceled = true; } });
    const storage = new InMemoryStorage("https://cdn.example");
    vi.spyOn(storage, "putStream").mockRejectedValue(new Error("S3 multipart part failed"));
    await expect(ingestStream(new Response(source), storage, async () => {})).rejects.toThrow("upload: S3 multipart part failed");
    expect(canceled).toBe(true);
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
