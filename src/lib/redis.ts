import Redis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

function createRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    return new Redis({ lazyConnect: true, enableOfflineQueue: false });
  }

  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // lazyConnect: don't open TCP connection at import time.
    // ioredis will auto-connect on first command. This prevents
    // ECONNREFUSED during `next build` (no Redis in Docker build stage).
    lazyConnect: true,
  });
}

export const redis =
  globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
