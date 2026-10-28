import { z } from "zod";
import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { queryCreatorInfo, type CreatorInfoResult } from "./tiktok-creator-info";
import { PermanentError, ConfirmationRequiredError, TransientError, TokenInvalidError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { readProviderBody } from "./download";
import { asString } from "./util";
import { safeFetch } from "@/lib/media/ssrf";

const API = "https://open.tiktokapis.com/v2";

const directOptions = z.object({
  privacyLevel: z.string().min(1),
  disableComment: z.boolean().default(true),
  disableDuet: z.boolean().default(true),
  disableStitch: z.boolean().default(true),
  brandContentToggle: z.boolean().default(false),
  brandOrganicToggle: z.boolean().default(false),
  coverTimestampMs: z.number().int().min(0).max(2147483647).optional(),
  aiDisclosed: z.boolean().optional(),
});

function isVerifiedPullUrl(videoUrl: string): boolean {
  const prefix = process.env.TIKTOK_PULL_URL_PREFIX;
  if (!prefix) return false;
  try {
    const configured = new URL(prefix);
    const video = new URL(videoUrl);
    if (configured.protocol !== "https:" || configured.username || configured.password || configured.search || configured.hash) return false;
    if (video.username || video.password || video.hash || video.origin !== configured.origin) return false;
    const path = configured.pathname;
    return video.pathname === path || video.pathname.startsWith(path.endsWith("/") ? path : `${path}/`);
  } catch {
    return false;
  }
}

const CAPS: FormatCapability[] = [
  {
    format: "video",
    media: { min: 1, max: 1, kinds: ["video"] },
    video: { maxDurationSec: 600, aspectRatios: ["9:16", "1:1", "16:9"] },
    caption: { maxLength: 2200, required: false },
    mediaIngestion: "pull_url",
  },
];

export function validateTikTokSubmission(creator: CreatorInfoResult, optionsInput: unknown, durationSec?: number | null) {
  if (creator.status === "cannot_post_now") {
    throw new ConfirmationRequiredError(`${creator.message} (${creator.reason})`);
  }
  const parsed = directOptions.safeParse(optionsInput);
  if (!parsed.success) throw new ConfirmationRequiredError(`tiktok: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const options = parsed.data;
  const info = creator.creator_info;
  if (!info.privacy_level_options.includes(options.privacyLevel)) {
    throw new ConfirmationRequiredError("tiktok: privacyLevel is not allowed by the creator");
  }
  if (options.brandContentToggle && options.privacyLevel === "SELF_ONLY") {
    throw new ConfirmationRequiredError("tiktok: Branded content visibility cannot be set to private");
  }
  const duration = durationSec;
  const creatorLimit = info.max_video_post_duration_sec;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || !creatorLimit) {
    throw new ConfirmationRequiredError("tiktok: video duration or creator duration limit unavailable; register media with duration and try again");
  }
  const maxDuration = Math.min(CAPS[0]!.video!.maxDurationSec!, creatorLimit);
  if (duration > maxDuration) throw new ConfirmationRequiredError(`tiktok: video duration exceeds ${maxDuration} seconds`);
  for (const [disabled, selected] of [[info.comment_disabled, options.disableComment], [info.duet_disabled, options.disableDuet], [info.stitch_disabled, options.disableStitch]]) {
    if (disabled && !selected) throw new ConfirmationRequiredError("TikTok interaction settings changed. Review and confirm again.");
  }
  return options;
}

export const tiktokProvider: Provider = {
  id: "tiktok",
  label: "TikTok",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true,

  oauthConfig() {
    const clientId = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: `${API}/oauth/token/`,
      scopes: ["user.info.basic", "video.upload", "video.publish"],
      clientId,
      clientSecret,
      clientIdParam: "client_key", // TikTok uses client_key, not client_id
      scopeSeparator: ",",
    };
  },

  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    const key = process.env.TIKTOK_CLIENT_KEY ?? "";
    return oauth2Refresh({
      tokenUrl: `${API}/oauth/token/`,
      clientId: key,
      clientSecret: process.env.TIKTOK_CLIENT_SECRET ?? "",
      refreshToken: tokens.refreshToken ?? "",
      extra: { client_key: key },
    });
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(`${API}/user/info/?fields=open_id`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { user?: { open_id?: string } };
      error?: { message?: string };
    };
    if (!res.ok) throw classifyHttp(res.status, json.error?.message);
    const id = json.data?.user?.open_id;
    if (!id) throw classifyHttp(404, "no tiktok user");
    return { accountId: id };
  },

  async publishStatus(tokens, handle) {
    let res: Response;
    let json: unknown;
    try {
      res = await fetch(`${API}/post/publish/status/fetch/`, {
        method: "POST", headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: handle.providerHandle }), redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      json = await res.json();
    } catch { throw new TransientError("TikTok status unavailable. Try again later."); }
    const parsed = z.object({ data: z.object({ status: z.string(), fail_reason: z.string().optional() }).optional(), error: z.object({ code: z.string() }) }).safeParse(json);
    if (parsed.success && parsed.data.error.code === "access_token_invalid") throw new TokenInvalidError("Reconnect the TikTok channel");
    if (!res.ok) throw classifyHttp(res.status, "TikTok status unavailable");
    if (!parsed.success || parsed.data.error.code !== "ok" || !parsed.data.data) throw new TransientError("TikTok status unavailable. Try again later.");
    const data = parsed.data.data;
    if (data.status === "FAILED") return { state: "failed", error: data.fail_reason || "TikTok processing failed" };
    if (data.status === "PUBLISH_COMPLETE") return { state: "published" };
    return { state: "accepted" };
  },

  async publish({ tokens, request, mediaUrls, mediaDurationsSec }): Promise<PublishHandle> {
    if (request.format !== "video") {
      throw new PermanentError(`tiktok: unsupported format '${request.format}'`);
    }
    const videoUrl = mediaUrls[0] ?? "";
    const direct = request.options?.publishMode === "direct";
    let postInfo: Record<string, unknown> | undefined;
    if (direct) {
      const creator = await queryCreatorInfo(tokens.accessToken);
      const options = validateTikTokSubmission(creator, request.options, mediaDurationsSec?.[0]);
      postInfo = {
        title: request.caption ?? "",
        privacy_level: options.privacyLevel,
        disable_comment: options.disableComment,
        disable_duet: options.disableDuet,
        disable_stitch: options.disableStitch,
        brand_content_toggle: options.brandContentToggle,
        brand_organic_toggle: options.brandOrganicToggle,
        ...(options.coverTimestampMs !== undefined ? { video_cover_timestamp_ms: options.coverTimestampMs } : {}),
        ...(options.aiDisclosed !== undefined ? { is_aigc: options.aiDisclosed } : {}),
      };
    }
    const usePull = isVerifiedPullUrl(videoUrl);
    // Inbox takes no post_info; Direct Post requires creator-selected settings.
    const endpoint = direct ? "/post/publish/video/init/" : "/post/publish/inbox/video/init/";

    const headers = {
      authorization: `Bearer ${tokens.accessToken}`,
      "content-type": "application/json",
    };

    // Build source_info. FILE_UPLOAD downloads the bytes here (single chunk for <= 64MB).
    let sourceInfo: Record<string, unknown>;
    let videoBytes: Uint8Array<ArrayBuffer> | undefined;
    if (usePull) {
      sourceInfo = { source: "PULL_FROM_URL", video_url: videoUrl };
    } else {
      const dl = await safeFetch(videoUrl); // SSRF guard on the stored media URL (defense-in-depth)
      // PSA36: download + init are pre-commit (the draft/post isn't created until the chunk upload).
      if (!dl.ok) {
        await dl.body?.cancel().catch(() => {}); // release the streamed socket — body is never read here
        throw classifyHttp(dl.status, `tiktok: cannot fetch video for upload (${dl.status})`, "pre_commit");
      }
      // PSA52: cap DURING the read (single-chunk upload tops out at 64 MB) — the old check buffered the
      // whole body first, so the limit didn't prevent the OOM it was meant to bound.
      videoBytes = await readProviderBody(dl, 64 * 1024 * 1024);
      const size = videoBytes.byteLength;
      sourceInfo = { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 };
    }

    const initBody: Record<string, unknown> = { source_info: sourceInfo };
    if (postInfo) initBody.post_info = postInfo;

    const init = await fetch(`${API}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(initBody),
    });
    const initJson = (await init.json().catch(() => ({}))) as {
      data?: { publish_id?: unknown; upload_url?: string };
      error?: { code?: string; message?: string };
    };
    const publishId = asString(initJson.data?.publish_id); // PSA51
    if (!init.ok || !publishId) {
      // TikTok often returns HTTP 200 with a non-"ok" error code (e.g. url_ownership_unverified).
      if (["spam_risk_too_many_posts", "spam_risk_user_banned_from_posting", "reached_active_user_cap"].includes(initJson.error?.code ?? "")) {
        throw new ConfirmationRequiredError("TikTok cannot accept posts right now. Try again later and confirm again.");
      }
      const msg = initJson.error?.message || initJson.error?.code || `tiktok init failed (${init.status})`;
      throw classifyHttp(init.ok ? 400 : init.status, msg, "pre_commit"); // PSA36: init creates no post yet
    }

    // FILE_UPLOAD: PUT the bytes to the returned upload_url (single chunk).
    if (!usePull) {
      const uploadUrl = initJson.data?.upload_url;
      if (!uploadUrl || !videoBytes) {
        throw new PermanentError("tiktok: init returned no upload_url for FILE_UPLOAD");
      }
      const size = videoBytes.byteLength;
      // PSA50: the upload URL comes from the init response — run it through the SSRF chokepoint so it
      // can't be pointed at an internal target (the PUT carries no token, so an SSRF guard suffices).
      const put = await safeFetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(size),
          "content-range": `bytes 0-${size - 1}/${size}`,
        },
        body: videoBytes,
      });
      // The PUT response body is never read (we only check status) — cancel it so the streamed
      // socket isn't held open until the inactivity timeout.
      const putFailed = !put.ok;
      await put.body?.cancel().catch(() => {});
      if (putFailed) throw classifyHttp(put.status, `tiktok: chunk upload failed (${put.status})`);
    }

    return { providerHandle: publishId, processing: true };
  },
};
