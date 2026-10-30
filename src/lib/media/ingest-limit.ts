import { ApiError } from "@/lib/api/response";

// Bound concurrent transfers and temporary disk usage; queue small bursts and return 429 beyond the cap.
const maxConcurrent = (): number => Number(process.env.MEDIA_INGEST_CONCURRENCY ?? 2);
const maxQueued = (): number => Number(process.env.MEDIA_INGEST_QUEUE ?? 8);

let active = 0;
const waiters: (() => void)[] = [];

/** Run `fn` holding one of the N ingest slots. Beyond N active + the queue cap → 429. */
export async function withIngestSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= maxConcurrent()) {
    if (waiters.length >= maxQueued()) {
      throw new ApiError("rate_limited", "Too many media ingests in progress", 429);
    }
    await new Promise<void>((res) => waiters.push(res)); // resolved with a slot handed to us
  } else {
    active += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next(); // pass our slot directly to the next waiter (active count unchanged)
    else active -= 1;
  }
}

/** Test hooks. */
export function __ingestStats(): { active: number; queued: number } {
  return { active, queued: waiters.length };
}
export function __resetIngestLimit(): void {
  active = 0;
  waiters.length = 0;
}
