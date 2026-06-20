import { describe, it, expect, vi } from "vitest";
import { createTtlCache } from "./ttl-cache";

/** A mutable fake clock so tests control expiry deterministically (no real timers). */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("createTtlCache", () => {
  it("computes once and serves the cached value within the TTL", async () => {
    const clock = fakeClock();
    const cache = createTtlCache<number>({ ttlMs: 1_000, now: clock.now });
    const compute = vi.fn(async () => 42);

    expect(await cache.getOrCompute("k", compute)).toBe(42);
    clock.advance(999); // still inside the window
    expect(await cache.getOrCompute("k", compute)).toBe(42);

    expect(compute).toHaveBeenCalledTimes(1); // second call was served from cache
  });

  it("recomputes once the entry has expired", async () => {
    const clock = fakeClock();
    const cache = createTtlCache<number>({ ttlMs: 1_000, now: clock.now });
    let n = 0;
    const compute = vi.fn(async () => ++n);

    expect(await cache.getOrCompute("k", compute)).toBe(1);
    clock.advance(1_001); // past expiry
    expect(await cache.getOrCompute("k", compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("keys are independent", async () => {
    const cache = createTtlCache<string>({ ttlMs: 1_000 });
    expect(await cache.getOrCompute("a", async () => "A")).toBe("A");
    expect(await cache.getOrCompute("b", async () => "B")).toBe("B");
    expect(cache.size).toBe(2);
  });

  it("ttlMs <= 0 disables caching: every call computes and nothing is stored", async () => {
    const cache = createTtlCache<number>({ ttlMs: 0 });
    const compute = vi.fn(async () => 7);
    await cache.getOrCompute("k", compute);
    await cache.getOrCompute("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it("does not cache a thrown error (next call retries)", async () => {
    const cache = createTtlCache<number>({ ttlMs: 1_000 });
    const compute = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(5);

    await expect(cache.getOrCompute("k", compute)).rejects.toThrow("boom");
    expect(cache.size).toBe(0); // failure left the cache empty
    expect(await cache.getOrCompute("k", compute)).toBe(5); // retry succeeds and caches
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("invalidate drops a single key, forcing a recompute", async () => {
    const cache = createTtlCache<number>({ ttlMs: 10_000 });
    let n = 0;
    const compute = async () => ++n;
    expect(await cache.getOrCompute("k", compute)).toBe(1);
    cache.invalidate("k");
    expect(await cache.getOrCompute("k", compute)).toBe(2);
  });

  it("clear empties the whole cache", async () => {
    const cache = createTtlCache<number>({ ttlMs: 10_000 });
    await cache.getOrCompute("a", async () => 1);
    await cache.getOrCompute("b", async () => 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("enforces maxEntries by evicting expired entries first, then the oldest", async () => {
    const clock = fakeClock();
    const cache = createTtlCache<number>({ ttlMs: 1_000, maxEntries: 2, now: clock.now });

    await cache.getOrCompute("old", async () => 1); // expires at 2_000
    clock.advance(1_500); // "old" is now expired (t=2_500 > 2_000)
    await cache.getOrCompute("b", async () => 2); // expires at 3_500
    await cache.getOrCompute("c", async () => 3); // overflow → expired "old" is dropped

    expect(cache.size).toBe(2);
    // "old" was evicted (expired); "b" and "c" remain fresh.
    const fresh = vi.fn(async () => 99);
    expect(await cache.getOrCompute("b", fresh)).toBe(2);
    expect(await cache.getOrCompute("c", fresh)).toBe(3);
    expect(fresh).not.toHaveBeenCalled();
  });
});
