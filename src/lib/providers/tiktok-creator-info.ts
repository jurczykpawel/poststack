import { z } from "zod";
import { PermanentError, RateLimitedError, TokenInvalidError, TransientError } from "./errors";
import { classifyHttp } from "./http";

const creatorInfoSchema = z.object({
  creator_nickname: z.string(),
  creator_username: z.string().optional(),
  creator_avatar_url: z.string(),
  privacy_level_options: z.array(z.string()),
  comment_disabled: z.boolean(),
  duet_disabled: z.boolean(),
  stitch_disabled: z.boolean(),
  max_video_post_duration_sec: z.number().int().positive().optional(),
});

export type CreatorInfo = z.infer<typeof creatorInfoSchema>;
const cannotPostReasons = [
  "spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap",
] as const;
export type CannotPostReason = typeof cannotPostReasons[number];
export type CreatorInfoResult =
  | { status: "available"; creator_info: CreatorInfo }
  | { status: "cannot_post_now"; reason: CannotPostReason; message: string };

/** Query current Direct Post permissions. This client always calls TikTok; caching belongs to the channel service. */
export async function queryCreatorInfo(accessToken: string): Promise<CreatorInfoResult> {
  let res: Response;
  let json: unknown;
  try {
    res = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    json = await res.json().catch(() => null);
  } catch {
    throw new TransientError("TikTok creator info unavailable. Try again later.", "pre_commit");
  }
  const envelope = z.object({ data: z.unknown().optional(), error: z.object({ code: z.string() }) }).safeParse(json);
  const code = envelope.success ? envelope.data.error.code : undefined;
  if (code === "access_token_invalid") throw new TokenInvalidError("Reconnect the TikTok channel");
  if (code === "scope_not_authorized") throw new PermanentError("Reconnect TikTok with video.publish permission");
  if (res.status === 429 || code === "rate_limit_exceeded") {
    throw new RateLimitedError("TikTok creator info rate limit. Try again later.", 60, "pre_commit");
  }
  if ((res.ok || res.status === 403) && cannotPostReasons.some((reason) => reason === code)) {
    return {
      status: "cannot_post_now", reason: code as CannotPostReason,
      message: "TikTok cannot accept posts right now. Try again later.",
    };
  }
  if (!res.ok) throw classifyHttp(res.status, "TikTok creator info unavailable", "pre_commit");
  if (!envelope.success || code !== "ok") {
    throw new TransientError("TikTok creator info unavailable. Try again later.", "pre_commit");
  }
  const data = creatorInfoSchema.safeParse(envelope.data.data);
  if (!data.success) throw new TransientError("TikTok creator info incomplete. Try again later.", "pre_commit");
  return { status: "available", creator_info: data.data };
}
