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
