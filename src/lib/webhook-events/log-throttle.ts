import { getClientIp } from "@/lib/api/rate-limit";

/**
 * OBS1 follow-up — bound unauthenticated DB-write amplification.
 *
 * The `rejected_*` POST logs and the GET `handshake_fail` log fire on PUBLIC, pre-auth,
 * PRE-rate-limit code paths (the per-page rate limit in route.ts sits AFTER the HMAC check). Each
 * writes its own `webhook_events` row with a unique event_key and no dedup, so a flood of
 * bad-signature / oversized / unparseable POSTs (or bad GET handshakes) would grow `webhook_events`
 * without bound — a storage/DoS amplification that did not exist before OBS1 (the old code returned
 * cheaply with no DB write).
 *
 * This throttles the ACT OF LOGGING those pre-auth events. A genuine, sporadic rejection is still
 * recorded for observability; once a burst exceeds the budget we still return the correct status
 * code (413/403/400) but SKIP the DB insert (and count the drop).
 *
 * In-memory + per-process BY DESIGN: it must add ZERO DB work on the flood path (a DB-backed limiter
 * would itself be the amplification it is meant to prevent). Two token buckets, both of which must
 * yield a token: a per-client-IP bucket so one source cannot monopolise the budget, and a global
 * bucket as the absolute ceiling across all sources (covers IP rotation / an un-proxied instance
 * where every client collapses to "unknown"). The daily webhook_events compaction job is
 * complementary defence-in-depth — it does NOT replace this, since a burst spikes storage between
 * prunes.
 */

interface Bucket {
  tokens: number;
  /** epoch ms of the last refill. */
  last: number;
}

/** Per-client-IP budget: at most this many rejection logs per IP per minute (smooth refill). */
const PER_IP_CAPACITY = 30;
const PER_IP_REFILL_PER_SEC = PER_IP_CAPACITY / 60;

/** Global ceiling across ALL sources: at most this many rejection logs per minute, process-wide. */
const GLOBAL_CAPACITY = 300;
const GLOBAL_REFILL_PER_SEC = GLOBAL_CAPACITY / 60;

/** Cap the per-IP map so a stream of distinct (e.g. rotated/spoofed-but-distinct) keys can't grow it
 *  unbounded; when it gets large we evict fully-refilled (idle) entries — they carry no state. */
const MAX_TRACKED_IPS = 10_000;

function makeBucketStore(capacity: number, refillPerSec: number) {
  const buckets = new Map<string, Bucket>();

  function take(key: string, now: number): boolean {
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= MAX_TRACKED_IPS) {
        for (const [k, v] of buckets) {
          const refilled = Math.min(capacity, v.tokens + ((now - v.last) / 1000) * refillPerSec);
          if (refilled >= capacity) buckets.delete(k);
        }
      }
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
      b.last = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  }

  return { take, reset: () => buckets.clear() };
}

const perIp = makeBucketStore(PER_IP_CAPACITY, PER_IP_REFILL_PER_SEC);
const global = makeBucketStore(GLOBAL_CAPACITY, GLOBAL_REFILL_PER_SEC);

let droppedCount = 0;

/**
 * True if the throttle has budget to log one pre-auth rejection for this request. Consume the per-IP
 * token first; only spend a global token when the per-IP bucket allowed, so a single throttled IP
 * cannot drain the global ceiling on behalf of everyone else.
 */
export function allowRejectionLog(request: Request, now: number = Date.now()): boolean {
  const ip = getClientIp(request);
  if (!perIp.take(ip, now)) {
    droppedCount++;
    return false;
  }
  if (!global.take("global", now)) {
    droppedCount++;
    return false;
  }
  return true;
}

/** Number of rejection logs skipped by the throttle since process start (or last reset). */
export function droppedRejectionLogCount(): number {
  return droppedCount;
}

/** Test-only: clear all buckets + the dropped counter so a suite starts from a full budget. */
export function resetRejectionLogThrottle(): void {
  perIp.reset();
  global.reset();
  droppedCount = 0;
}
