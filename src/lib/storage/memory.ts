import type { Storage, HeadResult } from "./types";

/** Test/dev storage — keeps bytes in a Map. */
export class InMemoryStorage implements Storage {
  private objects = new Map<string, Uint8Array>();
  constructor(private baseUrl: string) {}

  async putBytes(
    key: string,
    bytes: Uint8Array,
    _contentType?: string,
    _metadata?: Record<string, string>,
  ): Promise<void> {
    this.objects.set(key, bytes);
  }
  async putStream(key: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) throw new Error("Configure S3 storage for media above 256 MiB");
      parts.push(chunk.slice());
    }
    this.objects.set(key, Buffer.concat(parts));
  }
  async copy(from: string, to: string): Promise<void> {
    const bytes = this.objects.get(from);
    if (!bytes) throw new Error("Missing storage object");
    this.objects.set(to, bytes);
  }
  async head(key: string): Promise<HeadResult> {
    const o = this.objects.get(key);
    return o ? { exists: true, size: o.byteLength } : { exists: false };
  }
  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${key}`;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}
