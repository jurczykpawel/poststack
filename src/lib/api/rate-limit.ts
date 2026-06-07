import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Fixed-window rate limiter, Postgres-backed (replaces Redis INCR + EXPIRE).
 * One atomic `INSERT ... ON CONFLICT` per request increments the window counter,
 * resetting it when the previous window has elapsed. The atomicity (no lost
 * increments under concurrency) lives in the row lock on the conflict.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const result = await db.execute(sql`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limit_counters.window_start < now() - (${windowSeconds} * interval '1 second')
            THEN 1 ELSE rate_limit_counters.count + 1 END,
          window_start = CASE
            WHEN rate_limit_counters.window_start < now() - (${windowSeconds} * interval '1 second')
            THEN now() ELSE rate_limit_counters.window_start END
    RETURNING count, window_start`);

  const row = result.rows[0] as { count: number | string; window_start: string | Date };
  const count = Number(row.count);
  const windowEndMs = new Date(row.window_start).getTime() + windowSeconds * 1000;
  const retryAfter = count > limit ? Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000)) : 0;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter,
  };
}

/**
 * Resolve the client IP from headers a reverse proxy can be trusted to set.
 *
 * Client-supplied headers (CF-Connecting-IP, the leftmost X-Forwarded-For entry)
 * are forgeable and would let a caller mint unlimited rate-limit buckets, so they
 * are NOT trusted by default. We use X-Real-IP (the proxy sets it to the socket
 * peer) or the rightmost X-Forwarded-For hop (the value the proxy itself added).
 * CF-Connecting-IP is honoured only when `trustedProxy` is "cloudflare".
 */
export function getClientIp(request: Request, trustedProxy: string = env.TRUSTED_PROXY): string {
  if (trustedProxy === "cloudflare") {
    const cf = request.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;

  // Rightmost hop = the entry the nearest proxy appended (not the client-controlled left).
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }

  return "unknown";
}
