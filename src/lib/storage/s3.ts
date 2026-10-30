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

const xmlEscape = (value: string): string => value.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const xmlValue = (xml: string, tag: string): string => (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

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
  async putStream(key: string, chunks: AsyncIterable<Uint8Array>, contentType: string): Promise<void> {
    const url = this.objUrl(key);
    const init = await this.client.fetch(`${url}?uploads`, { method: "POST", headers: { "content-type": contentType } });
    const id = xmlValue(await init.text(), "UploadId");
    if (!init.ok || !id) throw new Error("S3 multipart initialization failed");
    const session = `${url}?uploadId=${encodeURIComponent(id)}`;
    const parts: string[] = [];
    let part = new Uint8Array(8 * 1024 * 1024), used = 0;
    const upload = async () => {
      const res = await this.client.fetch(`${session}&partNumber=${parts.length + 1}`, { method: "PUT", body: part.subarray(0, used) });
      const etag = res.headers.get("etag");
      await res.body?.cancel();
      if (!res.ok || !etag) throw new Error("S3 multipart part failed");
      parts.push(`<Part><PartNumber>${parts.length + 1}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`);
      part = new Uint8Array(part.length); used = 0;
    };
    try {
      for await (const chunk of chunks) {
        for (let offset = 0; offset < chunk.length;) {
          const n = Math.min(part.length - used, chunk.length - offset);
          part.set(chunk.subarray(offset, offset + n), used); used += n; offset += n;
          if (used === part.length) await upload();
        }
      }
      if (used || !parts.length) await upload();
      const res = await this.client.fetch(session, { method: "POST", headers: { "content-type": "application/xml" }, body: `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>` });
      if (!res.ok || /<Error[>\s]/.test(await res.text())) throw new Error("S3 multipart completion failed");
    } catch (err) {
      await this.client.fetch(session, { method: "DELETE" }).then(r => r.body?.cancel()).catch(() => {});
      throw err;
    }
  }
  async copy(from: string, to: string, contentType: string, metadata: Record<string, string>): Promise<void> {
    const headers: Record<string, string> = { "x-amz-copy-source": `/${this.cfg.bucket}/${from}`, "x-amz-metadata-directive": "REPLACE", "content-type": contentType };
    for (const [key, value] of Object.entries(metadata)) headers[`x-amz-meta-${key}`] = value;
    const res = await this.client.fetch(this.objUrl(to), { method: "PUT", headers });
    if (!res.ok || /<Error[>\s]/.test(await res.text())) throw new Error("S3 copy failed");
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
