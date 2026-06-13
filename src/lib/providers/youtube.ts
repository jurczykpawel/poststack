import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { PermanentError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { assertAllowedHost } from "./follow";
import { readProviderBody, readProviderCover } from "./download";
import { asString } from "./util";
import { safeFetch } from "@/lib/media/ssrf";

const CAPS: FormatCapability[] = [
  {
    format: "short",
    media: { min: 1, max: 1, kinds: ["video"] },
    video: { maxDurationSec: 60, aspectRatios: ["9:16"] },
    title: { maxLength: 100, required: true },
    caption: { maxLength: 5000, required: false },
    mediaIngestion: "resumable_upload",
  },
  {
    format: "video",
    media: { min: 1, max: 1, kinds: ["video"] },
    title: { maxLength: 100, required: true },
    caption: { maxLength: 5000, required: false },
    mediaIngestion: "resumable_upload",
  },
];

export const youtubeProvider: Provider = {
  id: "youtube",
  label: "YouTube",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true,

  oauthConfig() {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube.readonly",
      ],
      clientId,
      clientSecret,
      // access_type=offline → durable refresh_token; prompt=consent forces it; select_account shows the
      // account chooser so you can pick the Google account that actually owns the YouTube channel
      // (otherwise Google silently reuses a logged-in account that may have no channel → 401).
      extraAuthParams: { access_type: "offline", prompt: "select_account consent" },
    };
  },

  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    return oauth2Refresh({
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: process.env.YOUTUBE_CLIENT_ID ?? "",
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
      refreshToken: tokens.refreshToken ?? "",
    });
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    // Auth MUST be the Bearer header — Google removed the `?access_token=` query-param method, which
    // now 401s (that broke every YouTube reconnect). `publish` already uses the header.
    const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = res.statusText || String(res.status);
      let reason = "";
      try {
        const e = (JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
        reason = e?.errors?.[0]?.reason ?? "";
        msg = e?.message ?? msg;
      } catch { /* non-json body */ }
      // The usual reconnect failure: the chosen Google account simply has no YouTube channel (Google
      // 401s `youtubeSignupRequired`). Give an actionable message instead of a bare "Unauthorized".
      if (reason === "youtubeSignupRequired") {
        msg = "this Google account has no YouTube channel — Reconnect and choose the Google account that owns the channel";
      }
      console.error("[youtube healthCheck]", res.status, reason || msg, "tokenLen=" + (tokens.accessToken ?? "").length);
      throw classifyHttp(res.status, msg);
    }
    type Thumb = { url?: string };
    let json: { items?: { id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: Thumb; medium?: Thumb } } }[] } = {};
    try { json = JSON.parse(text); } catch { /* leave empty → 404 below */ }
    const item = json.items?.[0];
    const accountId = asString(item?.id); // PSA51
    if (!accountId) throw classifyHttp(404, "no channel for token");
    // accountId = the canonical channel id (UC…); displayName = channel title; avatar = channel thumbnail.
    // customUrl is the human-readable @handle (e.g. "@techskills") — stored in metadata for display.
    const thumbs = item?.snippet?.thumbnails;
    return {
      accountId,
      displayName: item?.snippet?.title,
      avatarUrl: thumbs?.default?.url ?? thumbs?.medium?.url,
      handle: item?.snippet?.customUrl,
    };
  },

  async publish({ tokens, request, mediaUrls }): Promise<PublishHandle> {
    if (request.format !== "short" && request.format !== "video") {
      throw new PermanentError(`youtube: unsupported format '${request.format}'`);
    }
    const videoUrl = mediaUrls[0] ?? "";

    // YouTube has no PULL — it needs the bytes. Fetch them (SSRF-guarded), then resumable-upload.
    const dl = await safeFetch(videoUrl);
    // PSA36: download + resumable-init are pre-commit (no video exists until the PUT upload completes).
    if (!dl.ok) throw classifyHttp(dl.status, `youtube: cannot fetch video for upload (${dl.status})`, "pre_commit");
    const bytes = await readProviderBody(dl); // PSA52: streamed size cap (no full-buffer OOM)
    const size = bytes.byteLength;

    const opts = request.options ?? {};
    const privacyStatus =
      typeof opts.privacyStatus === "string" ? opts.privacyStatus : "private"; // safe default
    const metadata = {
      snippet: {
        title: request.title ?? "Untitled",
        description: request.caption ?? "",
        ...(Array.isArray(opts.tags) ? { tags: opts.tags } : {}),
        ...(typeof opts.categoryId === "string" ? { categoryId: opts.categoryId } : {}),
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: opts.madeForKids === true, // required by the API
      },
    };

    // 1) initialize the resumable session — returns the upload URI in the Location header.
    const init = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "video/mp4",
          "x-upload-content-length": String(size),
        },
        body: JSON.stringify(metadata),
      },
    );
    if (!init.ok) {
      const e = (await init.json().catch(() => ({}))) as { error?: { message?: string } };
      throw classifyHttp(init.status, e.error?.message, "pre_commit"); // PSA36: init creates no video yet
    }
    const location = init.headers.get("location");
    if (!location) throw new PermanentError("youtube: resumable init returned no upload URL");
    // PSA50: the resumable session URL comes from the response — only follow it to a Google host.
    assertAllowedHost(location, ["googleapis.com", "googleusercontent.com"]);

    // 2) upload the bytes in a single request (videos up to YouTube's per-request limit).
    const up = await fetch(location, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(size) },
      body: bytes,
    });
    const upJson = (await up.json().catch(() => ({}))) as { id?: unknown; error?: { message?: string } };
    const handle = asString(upJson.id); // PSA51
    if (!up.ok || !handle) throw classifyHttp(up.status, upJson.error?.message);

    // Custom thumbnail (best-effort — the video is already uploaded; don't fail the publish on this).
    const coverUrl = typeof opts.coverUrl === "string" ? opts.coverUrl : undefined;
    if (coverUrl) {
      try {
        const img = await safeFetch(coverUrl); // SSRF guard — coverUrl is caller-supplied
        if (img.ok) {
          const imgBytes = await readProviderCover(img); // PSA52
          const ct = img.headers.get("content-type") ?? "image/png";
          await fetch(
            `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${handle}`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": ct },
              body: imgBytes,
            },
          );
        }
      } catch {
        /* thumbnail is best-effort */
      }
    }

    return { providerHandle: handle };
  },
};
