import { describe, it, expect, vi } from "vitest";
import { S3Storage } from "./s3";

// The S3 adapter is a thin signer over aws4fetch. We assert the REST contract it builds (method, URL,
// headers, body) against a fake AwsClient.fetch, plus the head/delete status handling — the live-
// endpoint behaviour is proven separately by a real B2 round-trip (deploy verification).
const cfg = {
  endpoint: "https://s3.us-west-002.backblazeb2.com",
  region: "us-west-002",
  bucket: "unify-test-bucket",
  accessKeyId: "KID",
  secretAccessKey: "SECRET",
  publicBaseUrl: "https://cdn.example.com/file/unify-test-bucket",
};

function withFetch(impl: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const s = new S3Storage(cfg);
  // @ts-expect-error reach into the private client to stub its signed fetch
  s.client = { fetch: vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return impl(url, init); }) };
  return { s, calls };
}

describe("S3Storage", () => {
  it("publicUrl serves from the public base (not the signing endpoint)", () => {
    const s = new S3Storage(cfg);
    expect(s.publicUrl("ab/cd/hash.jpg")).toBe("https://cdn.example.com/file/unify-test-bucket/ab/cd/hash.jpg");
  });

  it("putBytes PUTs to endpoint/bucket/key with content-type + x-amz-meta-*", async () => {
    const { s, calls } = withFetch(() => new Response(null, { status: 200 }));
    await s.putBytes("k/ey.jpg", new Uint8Array([1, 2, 3]), "image/jpeg", { sha256: "abc" });
    expect(calls[0]!.url).toBe("https://s3.us-west-002.backblazeb2.com/unify-test-bucket/k/ey.jpg");
    expect(calls[0]!.init.method).toBe("PUT");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("image/jpeg");
    expect(h["x-amz-meta-sha256"]).toBe("abc");
  });

  it("putBytes throws on a non-2xx", async () => {
    const { s } = withFetch(() => new Response("denied", { status: 403 }));
    await expect(s.putBytes("k", new Uint8Array(), "application/octet-stream")).rejects.toThrow(/S3 put failed: 403/);
  });

  it("head returns exists:false on 404, exists:true + size on 200", async () => {
    const miss = withFetch(() => new Response(null, { status: 404 }));
    expect(await miss.s.head("nope")).toEqual({ exists: false });
    const hit = withFetch(() => new Response(null, { status: 200, headers: { "content-length": "123" } }));
    expect(await hit.s.head("yes")).toEqual({ exists: true, size: 123 });
  });

  it("delete tolerates a 404 (idempotent) but throws on other errors", async () => {
    const gone = withFetch(() => new Response(null, { status: 404 }));
    await expect(gone.s.delete("x")).resolves.toBeUndefined();
    const err = withFetch(() => new Response(null, { status: 500 }));
    await expect(err.s.delete("x")).rejects.toThrow(/S3 delete failed: 500/);
  });
});
