import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channels } from "@/db/schema";
import { db } from "@/lib/db";
import { decryptTokens } from "@/lib/crypto";
import { ApiError } from "@/lib/api/response";
import { createTtlCache } from "@/lib/cache/ttl-cache";
import { queryCreatorInfo, type CreatorInfoResult } from "@/lib/providers/tiktok-creator-info";

const cache = createTtlCache<CreatorInfoResult>({ ttlMs: 60_000, now: () => Date.now() });

/** Pass refresh: true when publishing to query current permissions instead of using the compose cache. */
export async function getTikTokCreatorInfo(
  workspaceId: string,
  channelId: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<CreatorInfoResult> {
  const channel = await db.query.channels.findFirst({
    where: and(eq(channels.id, channelId), eq(channels.workspace_id, workspaceId)),
    columns: { platform: true, platform_id: true, token_encrypted: true },
  });
  if (!channel) throw new ApiError("not_found", "Channel not found", 404);
  if (channel.platform !== "tiktok") throw new ApiError("bad_request", "Creator info requires a TikTok channel", 400);
  const version = createHash("sha256").update(channel.platform_id).update(channel.token_encrypted).digest("hex");
  const key = `${workspaceId}:${channelId}:${version}`;
  if (refresh) cache.invalidate(key);
  return cache.getOrCompute(key, async () => {
    let accessToken: string;
    try {
      accessToken = decryptTokens(channel.token_encrypted).access_token;
      if (!accessToken) throw new Error("Missing credentials");
    } catch {
      throw new ApiError("bad_request", "Channel token cannot be decrypted — reconnect the channel", 400);
    }
    return queryCreatorInfo(accessToken);
  });
}
