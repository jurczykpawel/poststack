import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { PermanentError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { readProviderBody } from "./download";
import { asString } from "./util";
import { safeFetch } from "@/lib/media/ssrf";

const API = "https://open.tiktokapis.com/v2";

const CAPS: FormatCapability[] = [
  {
    format: "video",
    media: { min: 1, max: 1, kinds: ["video"] },
    video: { maxDurationSec: 600, aspectRatios: ["9:16", "1:1", "16:9"] },
    caption: { maxLength: 2200, required: false },
    mediaIngestion: "pull_url",
  },
];

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

  async publish({ tokens, request, mediaUrls }): Promise<PublishHandle> {
    if (request.format !== "video") {
      throw new PermanentError(`tiktok: unsupported format '${request.format}'`);
    }
    const videoUrl = mediaUrls[0] ?? "";
    const direct = request.options?.publishMode === "direct";
    // Ingestion: FILE_UPLOAD (default) uploads the bytes — storage-agnostic, no TikTok URL-domain
    // verification needed. PULL_FROM_URL is opt-in and requires a verified URL prefix in the app.
    const usePull = request.options?.ingestion === "pull_url";

    // Endpoint: Inbox (default, `video.upload`, no audit) → DRAFT in the app; the creator sets
    // caption/cover/privacy there (inbox takes NO post_info). Direct (`video.publish`) carries
    // post_info but UNAUDITED clients are forced to SELF_ONLY (private). TikTok has no
    // custom-cover-IMAGE API — only a video-frame timestamp, and only on direct.
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
    if (direct) {
      const coverTs =
        typeof request.options?.coverTimestampMs === "number"
          ? request.options.coverTimestampMs
          : undefined;
      const privacy =
        typeof request.options?.privacyLevel === "string"
          ? request.options.privacyLevel
          : "SELF_ONLY"; // unaudited clients are restricted to private regardless
      initBody.post_info = {
        title: request.caption ?? "",
        privacy_level: privacy,
        ...(coverTs !== undefined ? { video_cover_timestamp_ms: coverTs } : {}),
      };
    }

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

    return { providerHandle: publishId };
  },
};
