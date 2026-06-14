import { AwsClient } from "aws4fetch";
import type { Storage, HeadResult } from "./types";

export interface S3Config {
  endpoint: string; // e.g. https://<acct>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string; // e.g. https://cdn.example.com
}

/** Thin S3-compatible adapter (R2/MinIO/S3). Not integration-tested here — verify against a live endpoint. */
export class S3Storage implements Storage {
  private client: AwsClient;
  constructor(private cfg: S3Config) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    });
  }
  private objUrl(key: string): string {
    return `${this.cfg.endpoint.replace(/\/$/, "")}/${this.cfg.bucket}/${key}`;
  }
  async putBytes(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    const headers: Record<string, string> = { "content-type": contentType };
    for (const [k, v] of Object.entries(metadata)) headers[`x-amz-meta-${k}`] = v;
    const res = await this.client.fetch(this.objUrl(key), {
      method: "PUT",
      body: bytes as unknown as BodyInit,
      headers,
    });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status}`);
  }
  async head(key: string): Promise<HeadResult> {
    const res = await this.client.fetch(this.objUrl(key), { method: "HEAD" });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`S3 head failed: ${res.status}`);
    const len = res.headers.get("content-length");
    return { exists: true, size: len ? Number(len) : undefined };
  }
  publicUrl(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/$/, "")}/${key}`;
  }
  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.objUrl(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status}`);
  }
}
