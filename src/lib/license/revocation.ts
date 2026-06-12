// Revocation list (CRL) for license tokens. Licenses verify offline, so a refunded
// or otherwise revoked token would keep working forever — this lets the seller revoke
// one. The seller publishes a seller-scoped list of revoked `order` ids; the gate refuses
// a token whose `order` is on it.
//
// Resilience is the MIRROR of jwks.ts but fails the OTHER way: a transient outage must
// never lock out a paying customer, so on a failed/unreachable fetch we return the last
// known revocations (stale cache) or — with nothing cached — an EMPTY set (fail OPEN).
// An empty list from a healthy endpoint is the normal "nothing revoked" case, not an error.

type FetchImpl = (url: string) => Promise<Response>;

interface CacheEntry {
  orders: Set<string>;
  freshUntil: number;
  staleUntil: number;
}

const cache = new Map<string, CacheEntry>();
const FRESH_MS = 300_000; // 5 min
const STALE_MS = 7 * 24 * 60 * 60_000; // 7 days serve-stale-on-error

/** Test seam: clears the in-memory revocation cache. */
export function __resetRevocationCache(): void {
  cache.clear();
}

export interface RevocationResult {
  orders: Set<string>;
  /** True only when just fetched from the network this call. */
  fresh: boolean;
}

export interface GetRevocationsOpts {
  url: string;
  fetchImpl?: FetchImpl;
  now?: number;
}

export async function getRevocations(opts: GetRevocationsOpts): Promise<RevocationResult> {
  const fetchImpl = opts.fetchImpl ?? ((u: string) => fetch(u));
  const nowMs = opts.now ?? Date.now();

  const hit = cache.get(opts.url);
  if (hit && hit.freshUntil > nowMs) return { orders: hit.orders, fresh: false };

  try {
    const res = await fetchImpl(opts.url);
    if (!res.ok) throw new Error(`revocation ${res.status}`);
    const body = (await res.json()) as { orders?: unknown };
    const orders = new Set(Array.isArray(body.orders) ? body.orders.filter((o): o is string => typeof o === "string") : []);
    cache.set(opts.url, { orders, freshUntil: nowMs + FRESH_MS, staleUntil: nowMs + STALE_MS });
    return { orders, fresh: true };
  } catch {
    // Keep honoring known revocations during an outage; otherwise fail OPEN (empty set).
    if (hit && hit.staleUntil > nowMs) return { orders: hit.orders, fresh: false };
    return { orders: new Set(), fresh: false };
  }
}
