import { safeFetch } from "@/lib/media/ssrf";
import { sourceSize, sourceRange } from "./range-source";
import { readProviderBody } from "./download";
import { assertAllowedHost } from "./follow";
import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { PermanentError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { asString } from "./util";

const API = "https://api.linkedin.com/v2";

const CAPS: FormatCapability[] = [
  { format: "text", media: { min: 0, max: 0, kinds: [] }, caption: { maxLength: 3000, required: true }, mediaIngestion: "chunked_upload" },
  { format: "image", media: { min: 1, max: 9, kinds: ["image"] }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
  { format: "video", media: { min: 1, max: 1, kinds: ["video"] }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
  { format: "article", media: { min: 0, max: 1, kinds: ["image"] }, title: { maxLength: 200, required: true }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
];

export const linkedinProvider: Provider = {
  id: "linkedin",
  label: "LinkedIn",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true, // NOTE: programmatic refresh requires approval; ~1y hard cap (§16)

  oauthConfig() {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      scopes: ["openid", "profile", "w_member_social"],
      clientId,
      clientSecret,
    };
  },

  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    return oauth2Refresh({
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      clientId: process.env.LINKEDIN_CLIENT_ID ?? "",
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
      refreshToken: tokens.refreshToken ?? "",
    });
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(`${API}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as { sub?: unknown; name?: string; message?: string };
    if (!res.ok) throw classifyHttp(res.status, json.message);
    const accountId = asString(json.sub); // PSA55 (PSA51 class)
    if (!accountId) throw classifyHttp(404, "no linkedin user");
    return { accountId, displayName: json.name };
  },

  async publish({ tokens, accountId, request, mediaUrls }): Promise<PublishHandle> {
    const author = `urn:li:person:${accountId}`;
    const caption = request.caption ?? "";

    if (request.format === "text") {
      return { providerHandle: await createShare(tokens.accessToken, author, caption, "NONE", []) };
    }
    if (request.format === "article") {
      // Article needs an external content URL + a different ShareContent shape — flagged for live work.
      throw new PermanentError("linkedin: article publishing not implemented");
    }
    if (request.format !== "image" && request.format !== "video") {
      throw new PermanentError(`linkedin: unsupported format '${request.format}'`);
    }

    // LIPUB1: media publishing. Assets API — register an upload slot per media, PUT the bytes, then
    // create the share referencing the resulting asset URNs (READY). Count is capability-gated upstream.
    const urls = mediaUrls ?? [];
    if (urls.length === 0) throw new PermanentError(`linkedin: format '${request.format}' needs media`);
    const isVideo = request.format === "video";
    if (isVideo) return publishVideo(tokens.accessToken, author, caption, urls[0]!);
    const recipe = "urn:li:digitalmediaRecipe:feedshare-image";
    const assets: ShareMedia[] = [];
    for (const url of urls) {
      assets.push({ status: "READY", media: await uploadAsset(tokens.accessToken, author, recipe, url) });
    }
    return { providerHandle: await createShare(tokens.accessToken, author, caption, "IMAGE", assets) };
  },
};

type ShareMedia = { status: "READY"; media: string };

/** Create a ugcPost share (text = NONE, or IMAGE/VIDEO with pre-registered asset refs). Returns its URN. */
async function createShare(
  accessToken: string,
  author: string,
  caption: string,
  category: "NONE" | "IMAGE" | "VIDEO",
  media: ShareMedia[],
): Promise<string> {
  const res = await fetch(`${API}/ugcPosts`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      author,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: caption },
          shareMediaCategory: category,
          ...(media.length ? { media } : {}),
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { id?: unknown; message?: string };
  const handle = asString(json.id); // PSA51
  if (!res.ok || !handle) throw classifyHttp(res.status, json.message);
  return handle;
}

/** Register an upload slot for one media URL, PUT its bytes, and return the asset URN. */
async function uploadAsset(accessToken: string, owner: string, recipe: string, mediaUrl: string): Promise<string> {
  const reg = await fetch(`${API}/assets?action=registerUpload`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: [recipe],
        owner,
        serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
      },
    }),
  });
  const rj = (await reg.json().catch(() => ({}))) as {
    value?: { asset?: string; uploadMechanism?: Record<string, { uploadUrl?: string }> };
    message?: string;
  };
  if (!reg.ok) throw classifyHttp(reg.status, rj.message, "pre_commit");
  const asset = asString(rj.value?.asset);
  const uploadUrl = asString(rj.value?.uploadMechanism?.["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl);
  if (!asset || !uploadUrl) throw new PermanentError("linkedin: registerUpload returned no asset/uploadUrl");

  const src = await safeFetch(mediaUrl);
  if (!src.ok) {
    await src.body?.cancel();
    throw new PermanentError(`linkedin: cannot fetch media (${src.status})`);
  }
  const bytes = await readProviderBody(src, 16 * 1024 * 1024);
  assertAllowedHost(uploadUrl, ["linkedin.com", "licdn.com"]);
  const put = await fetch(uploadUrl, { method: "PUT", redirect: "error", headers: { authorization: `Bearer ${accessToken}` }, body: bytes });
  if (!put.ok) throw classifyHttp(put.status, "media upload failed", "pre_commit");
  return asset;
}

async function publishVideo(accessToken: string, owner: string, caption: string, url: string): Promise<PublishHandle> {
  const size = await sourceSize(url, Math.min(500 * 1024 * 1024, Number(process.env.PROVIDER_DOWNLOAD_MAX_BYTES ?? process.env.MEDIA_MAX_BYTES ?? 4 * 1024 ** 3)));
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "LinkedIn-Version": "202610", "X-Restli-Protocol-Version": "2.0.0" };
  const init = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }) });
  const json = await init.json() as { value?: { video: string; uploadToken?: string; uploadInstructions: { firstByte: number; lastByte: number; uploadUrl: string }[] } };
  if (!init.ok) throw classifyHttp(init.status, "linkedin: video initialization failed", "pre_commit");
  const value = json.value;
  if (!value?.video || !Array.isArray(value.uploadInstructions) || !value.uploadInstructions.length) throw new PermanentError("linkedin: missing upload instructions");
  const ids: string[] = [];
  let next = 0;
  for (const part of value.uploadInstructions) {
    if (part.firstByte !== next) throw new PermanentError("linkedin: invalid upload instructions");
    assertAllowedHost(part.uploadUrl, ["linkedin.com", "licdn.com"]);
    const bytes = await sourceRange(url, part.firstByte, part.lastByte, size);
    const put = await fetch(part.uploadUrl, { method: "PUT", redirect: "error", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes });
    await put.body?.cancel();
    if (!put.ok) throw classifyHttp(put.status, "linkedin: video part failed", "pre_commit");
    const etag = put.headers.get("etag");
    if (!etag) throw new PermanentError("linkedin: missing video part ID");
    ids.push(etag.replace(/^"|"$/g, "")); next = part.lastByte + 1;
  }
  if (next !== size) throw new PermanentError("linkedin: incomplete upload instructions");
  const final = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", { method: "POST", headers, body: JSON.stringify({ finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: ids } }) });
  await final.body?.cancel();
  if (!final.ok) throw classifyHttp(final.status, "linkedin: video finalization failed", "pre_commit");
  const post = await fetch("https://api.linkedin.com/rest/posts", { method: "POST", headers, body: JSON.stringify({ author: owner, commentary: caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { id: value.video } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) });
  const id = post.headers.get("x-restli-id");
  await post.body?.cancel();
  if (!post.ok || !id) throw classifyHttp(post.status, "linkedin: video post failed");
  return { providerHandle: id };
}
