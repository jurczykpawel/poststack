import { redis } from "@/lib/redis";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

/**
 * Rate limiter using Redis INCR + EXPIRE.
 * EXPIRE is always set (idempotent) to avoid orphaned keys if crash occurs.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  // Atomic pipeline: INCR + EXPIRE in one roundtrip, no crash window
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.expire(key, windowSeconds);
  const results = await pipeline.exec();

  const count = (results?.[0]?.[1] as number) ?? 1;
  const ttl = await redis.ttl(key);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfter: count > limit ? Math.max(ttl, 1) : 0,
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
