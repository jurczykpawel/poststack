// Revocation list (CRL) for license tokens. Licenses verify offline, so a refunded
// or otherwise revoked token would keep working forever — this lets the seller revoke
// one. The seller publishes SHA-256 hashes of revoked `order` ids; the gate refuses a
// token whose SHA-256(order) is on it.
//
// PRIVACY (k-anonymity range query): we never download the whole list. The gate hashes
// its own `order`, sends a short hex PREFIX of that hash, and gets back only the revoked
// hashes in that bucket — then checks membership locally. The server never sees the full
// hash and no single request reveals the total revocation count.
//
// Resilience is the MIRROR of jwks.ts but fails the OTHER way: a transient outage must
// never lock out a paying customer, so on a failed/unreachable fetch we return the last
// known bucket (stale cache) or — with nothing cached — an EMPTY set (fail OPEN).
// An empty bucket from a healthy endpoint is the normal "nothing revoked" case, not an error.

import { createHash } from "crypto";

type FetchImpl = (url: string) => Promise<Response>;

interface CacheEntry {
  hashes: Set<string>;
  freshUntil: number;
  staleUntil: number;
}

const cache = new Map<string, CacheEntry>();
const FRESH_MS = 300_000; // 5 min
const STALE_MS = 7 * 24 * 60 * 60_000; // 7 days serve-stale-on-error

/** Number of leading hex chars of SHA-256(order) sent as the bucket prefix (16 bits / 65536
 *  buckets). Must satisfy the server's `^[a-f0-9]{2,16}$` contract. */
export const REVOCATION_PREFIX_LENGTH = 4;

/** SHA-256 of an order id as lowercase hex — the value published on the CRL. */
export function orderHash(order: string): string {
  return createHash("sha256").update(order, "utf8").digest("hex");
}

/** Test seam: clears the in-memory revocation cache. */
export function __resetRevocationCache(): void {
  cache.clear();
}

export interface RevocationResult {
  /** Revoked SHA-256 order hashes in the requested prefix bucket. */
  hashes: Set<string>;
  /** True only when just fetched from the network this call. */
  fresh: boolean;
}

export interface GetRevocationsOpts {
  /** CRL endpoint, already carrying `?seller=<id>`. The prefix is appended here. */
  url: string;
  /** Hex prefix of SHA-256(order) — see REVOCATION_PREFIX_LENGTH. */
  prefix: string;
  fetchImpl?: FetchImpl;
  now?: number;
}

export async function getRevocations(opts: GetRevocationsOpts): Promise<RevocationResult> {
  const fetchImpl = opts.fetchImpl ?? ((u: string) => fetch(u));
  const nowMs = opts.now ?? Date.now();

  const sep = opts.url.includes("?") ? "&" : "?";
  const finalUrl = `${opts.url}${sep}prefix=${encodeURIComponent(opts.prefix)}`;

  const hit = cache.get(finalUrl);
  if (hit && hit.freshUntil > nowMs) return { hashes: hit.hashes, fresh: false };

  try {
    const res = await fetchImpl(finalUrl);
    if (!res.ok) throw new Error(`revocation ${res.status}`);
    const body = (await res.json()) as { order_hashes?: unknown };
    const hashes = new Set(
      Array.isArray(body.order_hashes) ? body.order_hashes.filter((o): o is string => typeof o === "string") : [],
    );
    cache.set(finalUrl, { hashes, freshUntil: nowMs + FRESH_MS, staleUntil: nowMs + STALE_MS });
    return { hashes, fresh: true };
  } catch {
    // Keep honoring known revocations during an outage; otherwise fail OPEN (empty set).
    if (hit && hit.staleUntil > nowMs) return { hashes: hit.hashes, fresh: false };
    return { hashes: new Set(), fresh: false };
  }
}
