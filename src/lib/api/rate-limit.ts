import { redis } from "@/lib/redis";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Sliding window rate limiter using Redis INCR + EXPIRE.
 *
 * @param key - Unique identifier (e.g. `rl:login:${ip}`)
 * @param limit - Max requests in window
 * @param windowSeconds - Window duration
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }

  const ttl = await redis.ttl(key);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: count > limit ? Math.max(ttl, 1) : 0,
  };
}

/**
 * Extract client IP from request headers.
 * Works behind reverse proxies (nginx, Cloudflare, etc.)
 */
export function getClientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
