// A tiny in-process, time-based memo. Wraps an expensive read (a grouped aggregate over a hot raw
// table) so repeated calls within a short window reuse the last result instead of re-scanning. This
// is the cheapest possible "refresh every N seconds" cache: no Redis, no infra, process-local — the
// web container is a single process, so a module-level Map is enough. Staleness up to `ttlMs` is the
// explicit trade: stats dashboards do not need to-the-millisecond accuracy.
//
// Disabled (ttlMs <= 0) → a pure pass-through: every call computes fresh, so behaviour is identical
// to having no cache at all. That is the env escape hatch (STATS_CACHE_TTL_MS=0).

export interface TtlCacheOptions {
  /** Entries live this long. <= 0 disables caching entirely (every call computes). */
  ttlMs: number;
  /** Soft cap on stored keys; on overflow we drop expired entries, then the oldest. */
  maxEntries?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export interface TtlCache<V> {
  /** Return the cached value for `key` if still fresh, else run `compute`, store, and return it. */
  getOrCompute(key: string, compute: () => Promise<V>): Promise<V>;
  /** Drop a single key (e.g. after a write that invalidates it). */
  invalidate(key: string): void;
  /** Drop everything. */
  clear(): void;
  /** Current number of stored entries (fresh + not-yet-evicted). For tests/introspection. */
  readonly size: number;
}

interface Entry<V> {
  value: V;
  expires: number;
}

const DEFAULT_MAX_ENTRIES = 500;

/**
 * Create an isolated TTL memo. Each call site owns its own cache instance, so keyspaces never
 * collide and one feature's cache can be cleared without touching another's.
 */
export function createTtlCache<V>(opts: TtlCacheOptions): TtlCache<V> {
  const { ttlMs } = opts;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock = opts.now ?? Date.now;
  const store = new Map<string, Entry<V>>();

  /** Bound memory: first drop expired entries; if still over the cap, drop oldest (insertion order). */
  function evict(nowMs: number): void {
    if (store.size <= maxEntries) return;
    for (const [k, e] of store) if (e.expires <= nowMs) store.delete(k);
    while (store.size > maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  return {
    async getOrCompute(key: string, compute: () => Promise<V>): Promise<V> {
      if (ttlMs <= 0) return compute(); // disabled → always fresh, never stored
      const nowMs = clock();
      const hit = store.get(key);
      if (hit && hit.expires > nowMs) return hit.value;
      // Compute outside the store: a thrown error must not poison the cache (nothing is stored).
      const value = await compute();
      store.set(key, { value, expires: nowMs + ttlMs });
      evict(nowMs);
      return value;
    },
    invalidate(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}
