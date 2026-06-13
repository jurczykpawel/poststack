import type { Storage } from "./types";
import { InMemoryStorage } from "./memory";

let cached: Storage | null = null;

/**
 * Resolve the configured object storage.
 *
 * Phase 1: returns an in-memory store (media tests inject their own Storage; the route layer uses
 * this). The real S3-compatible adapter (R2/MinIO via aws4fetch) is wired in Phase 4 when the dep is
 * added and a live endpoint is configured — at which point this switches on STORAGE_ENDPOINT.
 */
export function getStorage(): Storage {
  if (cached) return cached;
  const base = process.env.STORAGE_PUBLIC_BASE_URL ?? process.env.APP_URL ?? "http://localhost";
  cached = new InMemoryStorage(base);
  return cached;
}

/** Test seam: drop the cached storage so a test can reconfigure it. */
export function __resetStorage(): void {
  cached = null;
}
