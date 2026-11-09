export const PUBLISHING_OAUTH = {
  youtube: { name: "YouTube direct publishing", keys: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] },
  tiktok: { name: "TikTok", keys: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] },
  linkedin: { name: "LinkedIn", keys: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] },
  x: { name: "X", keys: ["X_CLIENT_ID", "X_CLIENT_SECRET"] },
  threads: { name: "Threads", keys: ["THREADS_CLIENT_ID", "THREADS_CLIENT_SECRET"] },
} as const;

export const PUBLISHING_OAUTH_KEYS = Object.values(PUBLISHING_OAUTH).flatMap(({ keys }) => [...keys]);
