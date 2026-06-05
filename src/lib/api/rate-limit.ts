import { prisma } from "@/lib/prisma";

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
  const rows = await prisma.$queryRaw<Array<{ count: number; window_start: Date }>>`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
            WHEN rate_limit_counters.window_start < now() - (${windowSeconds} * interval '1 second')
            THEN 1 ELSE rate_limit_counters.count + 1 END,
          window_start = CASE
            WHEN rate_limit_counters.window_start < now() - (${windowSeconds} * interval '1 second')
            THEN now() ELSE rate_limit_counters.window_start END
    RETURNING count, window_start`;

  const { count, window_start } = rows[0];
  const windowEndMs = window_start.getTime() + windowSeconds * 1000;
  const retryAfter = count > limit ? Math.max(1, Math.ceil((windowEndMs - Date.now()) / 1000)) : 0;

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter,
  };
}

/**
 * Extract client IP from request headers.
 * Prefers CF-Connecting-IP (set by Cloudflare, not spoofable behind CF proxy).
 * Falls back to X-Forwarded-For, X-Real-IP.
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
