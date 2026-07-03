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
    const recipe = isVideo ? "urn:li:digitalmediaRecipe:feedshare-video" : "urn:li:digitalmediaRecipe:feedshare-image";
    const assets: ShareMedia[] = [];
    for (const url of urls) {
      assets.push({ status: "READY", media: await uploadAsset(tokens.accessToken, author, recipe, url) });
    }
    return { providerHandle: await createShare(tokens.accessToken, author, caption, isVideo ? "VIDEO" : "IMAGE", assets) };
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

  const src = await fetch(mediaUrl);
  if (!src.ok) throw new PermanentError(`linkedin: cannot fetch media ${mediaUrl} (${src.status})`);
  const bytes = await src.arrayBuffer();
  const put = await fetch(uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${accessToken}` }, body: bytes });
  if (!put.ok) throw classifyHttp(put.status, "media upload failed", "pre_commit");
  return asset;
}
