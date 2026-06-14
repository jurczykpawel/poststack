import type { Storage } from "./types";
import { InMemoryStorage } from "./memory";
import { S3Storage } from "./s3";

let cached: Storage | null = null;

/**
 * Resolve the configured object storage. When `STORAGE_ENDPOINT` is set, use the S3-compatible
 * adapter (Backblaze B2 / Cloudflare R2 / MinIO / S3) — media is ingested into the bucket and served
 * from `STORAGE_PUBLIC_BASE_URL` (a public URL the platforms can pull, e.g. for a Meta `url=` publish).
 * With no endpoint configured it falls back to an in-memory store (dev / tests, which inject their own
 * Storage) so the app boots without object storage.
 */
export function getStorage(): Storage {
  if (cached) return cached;
  const endpoint = process.env.STORAGE_ENDPOINT;
  if (endpoint) {
    cached = new S3Storage({
      endpoint,
      region: process.env.STORAGE_REGION ?? "auto",
      bucket: process.env.STORAGE_PUBLIC_BUCKET ?? "poststack",
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
      publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL ?? endpoint,
    });
    return cached;
  }
  const base = process.env.STORAGE_PUBLIC_BASE_URL ?? process.env.APP_URL ?? "http://localhost";
  cached = new InMemoryStorage(base);
  return cached;
}

/** Test seam: drop the cached storage so a test can reconfigure it. */
export function __resetStorage(): void {
  cached = null;
}
