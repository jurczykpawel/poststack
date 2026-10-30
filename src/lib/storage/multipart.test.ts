import { describe, expect, it, vi } from "vitest";
import { S3Storage } from "./s3";
const cfg = { endpoint: "https://s3.example", region: "us-east-1", bucket: "media", accessKeyId: "test", secretAccessKey: "test", publicBaseUrl: "https://cdn.example" };
const MiB = 1024 * 1024;
function storage(fail = false) {
  const calls: { url: string; init: RequestInit }[] = [];
  const s = new S3Storage(cfg);
  Object.assign(s, { client: { fetch: vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("?uploads")) return new Response('<InitiateMultipartUploadResult><UploadId>a&amp;b</UploadId></InitiateMultipartUploadResult>');
    if (url.includes("partNumber")) return new Response(null, { status: fail ? 503 : 200, headers: { etag: '"etag"' } });
    return new Response('<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>');
  }) } });
  return { s, calls };
}
async function* data() { for (let i = 0; i < 17; i++) yield new Uint8Array(MiB).fill(i); }
describe("S3 multipart contract", () => {
  it("uploads bounded parts and completes using returned ETags in order", async () => {
    const { s, calls } = storage();
    await s.putStream("k", data(), "video/mp4");
    const parts = calls.filter(c => c.url.includes("partNumber"));
    expect(parts.map(c => (c.init.body as Uint8Array).byteLength)).toEqual([8 * MiB, 8 * MiB, MiB]);
    expect(parts[0]!.url).toContain("uploadId=a%26b");
    expect(String(calls.at(-1)!.init.body)).toContain('<PartNumber>3</PartNumber><ETag>&quot;etag&quot;</ETag>');
  });
  it("aborts multipart on a part failure", async () => {
    const { s, calls } = storage(true);
    await expect(s.putStream("k", data(), "video/mp4")).rejects.toThrow();
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });
  it("treats a 200 CompleteMultipartUpload Error XML as failure and aborts", async () => {
    const { s, calls } = storage();
    Object.assign(s, { client: { fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("?uploads")) return new Response('<UploadId>id</UploadId>');
      if (url.includes("partNumber")) return new Response(null, { headers: { etag: '"etag"' } });
      return new Response('<Error><Code>InternalError</Code></Error>');
    }) } });
    await expect(s.putStream("k", data(), "video/mp4")).rejects.toThrow();
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });
});
