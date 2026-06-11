// JWKS fetching for license verification. Ported from the captions verifier with
// one addition for the long-lived server: an `onFreshKeys` hook so the caller can
// persist a last-known-good snapshot to the DB, used as the durable fallback when
// the process cold-boots during a JWKS outage.
//
// Resilience contract: a transient JWKS outage (or an empty response) must never
// revoke a valid token. Order of preference on a failed/empty refresh:
//   last-known-good in-memory cache (up to 7 days) -> pinned fallback -> fail closed.

import type { JwksKey } from "@/lib/license/format";

type FetchImpl = (url: string) => Promise<Response>;

interface CacheEntry {
  keys: JwksKey[];
  freshUntil: number; // serve without refetching
  staleUntil: number; // serve on a failed refresh (outage), don't fail closed
}

const jwksCache = new Map<string, CacheEntry>();
const JWKS_FRESH_MS = 300_000; // 5 min
const JWKS_STALE_MS = 7 * 24 * 60 * 60_000; // 7 days serve-stale-on-error

/** Test seam: clears the in-memory JWKS cache. */
export function __resetJwksCache(): void {
  jwksCache.clear();
}

/**
 * Parse a pinned JWKS snapshot (`{ keys: [{ kid, alg, pem }] }`) from an env var
 * or DB column. Public-key material — safe to keep in config / the DB.
 */
export function parseJwksJson(raw: string | null | undefined): JwksKey[] {
  if (!raw) return [];
  try {
    const body = JSON.parse(raw) as { keys?: JwksKey[] };
    if (!Array.isArray(body.keys)) return [];
    return body.keys.filter((k): k is JwksKey => !!k && !!k.kid && !!k.pem);
  } catch {
    return [];
  }
}

export interface JwksResult {
  keys: JwksKey[];
  /** True only when the keys were just fetched from the network this call. */
  fresh: boolean;
}

export interface GetJwksOpts {
  url: string;
  fetchImpl?: FetchImpl;
  fallbackKeys?: JwksKey[];
  now?: number;
  /** Invoked with newly-fetched keys so the caller can persist a DB snapshot. */
  onFreshKeys?: (keys: JwksKey[]) => void;
}

export async function getJwks(opts: GetJwksOpts): Promise<JwksResult> {
  const { url } = opts;
  const fetchImpl = opts.fetchImpl ?? ((u: string) => fetch(u));
  const fallbackKeys = opts.fallbackKeys ?? [];
  const nowMs = opts.now ?? Date.now();

  const hit = jwksCache.get(url);
  if (hit && hit.freshUntil > nowMs) return { keys: hit.keys, fresh: false };

  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const body = (await res.json()) as { keys?: JwksKey[] };
    const keys = body.keys ?? [];
    // Treat an empty key set as a soft failure so it can't overwrite good keys.
    if (keys.length === 0) throw new Error("jwks empty");
    jwksCache.set(url, { keys, freshUntil: nowMs + JWKS_FRESH_MS, staleUntil: nowMs + JWKS_STALE_MS });
    opts.onFreshKeys?.(keys);
    return { keys, fresh: true };
  } catch (err) {
    if (hit && hit.staleUntil > nowMs) return { keys: hit.keys, fresh: false };
    if (fallbackKeys.length > 0) return { keys: fallbackKeys, fresh: false };
    throw err;
  }
}
