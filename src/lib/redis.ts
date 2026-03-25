import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function createRedis(): Redis {
  // During next build, REDIS_URL may be a dummy value — don't connect
  const url = process.env.REDIS_URL;
  if (!url) {
    // Return a placeholder that will fail at runtime if actually used without REDIS_URL
    return new Redis({ lazyConnect: true, enableOfflineQueue: false });
  }

  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: process.env.NEXT_PHASE === "phase-production-build",
  });
}

export const redis =
  globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
