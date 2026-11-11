import { oauthCredentials } from "./oauth-credentials";
import { safeFetch } from "@/lib/media/ssrf";
import { sourceSize, sourceRange } from "./range-source";
import { readProviderBody } from "./download";
import { assertAllowedHost } from "./follow";
import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle, PublishRequest, SubAccount } from "./types";
import { validate } from "./validate";
import { PermanentError, PermissionError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { asString } from "./util";

/** LinkedIn REST API version (`LinkedIn-Version` header) — single source of truth; bump here only. */
export const LINKEDIN_API_VERSION = "202610";

const API = "https://api.linkedin.com/v2";

const CAPS: FormatCapability[] = [
  { format: "text", media: { min: 0, max: 0, kinds: [] }, caption: { maxLength: 3000, required: true }, mediaIngestion: "chunked_upload" },
  { format: "image", media: { min: 1, max: 9, kinds: ["image"] }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
  { format: "video", media: { min: 1, max: 1, kinds: ["video"] }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
  { format: "article", requiredOptions: ["articleUrl"], media: { min: 0, max: 1, kinds: ["image"] }, title: { maxLength: 200, required: true }, caption: { maxLength: 3000, required: false }, mediaIngestion: "chunked_upload" },
];

export const linkedinProvider: Provider = {
  id: "linkedin",
  label: "LinkedIn",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true, // NOTE: programmatic refresh requires approval; ~1y hard cap (§16)

  async oauthConfig() {
    const { clientId, clientSecret } = await oauthCredentials("linkedin");
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      scopes: ["openid", "profile", "w_member_social"],
      // Company Pages: post as the organization + list the member's page roles and page names.
      subAccountScopes: ["w_organization_social", "r_organization_admin"],
      clientId,
      clientSecret,
    };
  },

  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    return oauth2Refresh({
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      ...await oauthCredentials("linkedin"),
      refreshToken: tokens.refreshToken ?? "",
    });
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(`${API}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as { sub?: unknown; name?: string; message?: string };
    if (!res.ok) throw classifyHttp(res.status, json.message, "commit_uncertain", { headers: res.headers, provider: "linkedin", body: json });
    const accountId = asString(json.sub); // PSA55 (PSA51 class)
    if (!accountId) throw classifyHttp(404, "no linkedin user");
    return { accountId, displayName: json.name };
  },

  /** Company Pages the member can post to; each becomes its own channel sharing the member token. */
  async enumerateSubAccounts(master: TokenSet): Promise<SubAccount[]> {
    const headers = restHeaders(master.accessToken);
    const acl = await fetch(`${REST}/organizationAcls?q=roleAssignee&state=APPROVED&count=100`, { headers });
    const json = await acl.json().catch(() => ({})) as { elements?: { organization?: unknown; role?: unknown }[]; message?: string };
    if (acl.status === 403) throw new PermissionError(PAGES_DENIED);
    if (!acl.ok) throw classifyHttp(acl.status, json.message, "pre_commit", { headers: acl.headers, provider: "linkedin", body: json });
    const ids = new Set<string>();
    for (const e of json.elements ?? []) {
      const id = /^urn:li:organization:(\d+)$/.exec(asString(e.organization) ?? "")?.[1];
      if (id && POSTING_ROLES.has(String(e.role))) ids.add(id);
    }
    const pages: SubAccount[] = [];
    for (const id of ids) {
      // Admin-only lookup; a content admin may get 403 — keep the page with a neutral name.
      const res = await fetch(`${REST}/organizations/${id}`, { headers });
      if (res.status === 401) throw classifyHttp(401, "linkedin: organization lookup", "pre_commit", { provider: "linkedin" });
      const org = res.ok ? await res.json().catch(() => ({})) as { localizedName?: unknown; vanityName?: unknown } : {};
      if (!res.ok) await res.body?.cancel();
      pages.push({
        platform: "linkedin", providerAccountId: id, token: master,
        displayName: asString(org.localizedName) ?? `LinkedIn Page ${id}`,
        metadata: { subKind: ORGANIZATION, ...(asString(org.vanityName) ? { vanityName: asString(org.vanityName) } : {}) },
      });
    }
    return pages;
  },

  async publish(args): Promise<PublishHandle> {
    const isPage = args.channelMetadata?.subKind === ORGANIZATION;
    try {
      return await publishAs(isPage ? `urn:li:organization:${args.accountId}` : `urn:li:person:${args.accountId}`, args);
    } catch (e) {
      if (isPage && e instanceof PermissionError) throw new PermissionError(`${PAGE_POST_DENIED} (${e.message})`);
      throw e;
    }
  },
};

const ORGANIZATION = "organization";
// Page roles allowed to publish organic posts (LinkedIn Company Page roles).
const POSTING_ROLES = new Set(["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"]);
const PAGES_DENIED = "LinkedIn did not allow reading your Company Pages (r_organization_admin). Add the Community Management API product to the LinkedIn app, or connect your personal profile instead.";
const PAGE_POST_DENIED = "LinkedIn refused to publish as this Company Page: you need the Page's Super admin or Content admin role and the w_organization_social permission — reconnect the Page";

async function publishAs(author: string, { tokens, request, mediaUrls, mediaKinds }: Parameters<Provider["publish"]>[0]): Promise<PublishHandle> {
  const caption = request.caption ?? "";

  if (request.format === "text") {
    return { providerHandle: await createShare(tokens.accessToken, author, caption, "NONE", []) };
  }
  if (request.format === "article") {
    const checked = validate(linkedinProvider, request, { mediaKinds });
    if (!checked.ok) throw new PermanentError(checked.errors.join("; "));
    return publishArticle(tokens.accessToken, author, request, mediaUrls[0]);
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
}

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
  if (!res.ok || !handle) throw classifyHttp(res.status, json.message, "commit_uncertain", { headers: res.headers, provider: "linkedin", body: json });
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
  if (!reg.ok) throw classifyHttp(reg.status, rj.message, "pre_commit", { headers: reg.headers, provider: "linkedin", body: rj });
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
  const failure = !put.ok ? await put.json().catch(() => undefined) : undefined;
  if (put.ok) await put.body?.cancel();
  if (!put.ok) throw classifyHttp(put.status, failure?.message ?? "media upload failed", "pre_commit", { headers: put.headers, provider: "linkedin", body: failure });
  return asset;
}

const REST = "https://api.linkedin.com/rest";
const restHeaders = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, "content-type": "application/json", "LinkedIn-Version": LINKEDIN_API_VERSION, "X-Restli-Protocol-Version": "2.0.0" });

async function publishArticle(accessToken: string, author: string, request: PublishRequest, imageUrl?: string): Promise<PublishHandle> {
  const headers = restHeaders(accessToken);
  let thumbnail: string | undefined;
  if (imageUrl) {
    const init = await fetch(`${REST}/images?action=initializeUpload`, { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner: author } }) });
    const json = await init.json().catch(() => ({})) as { value?: { image?: string; uploadUrl?: string }; message?: string };
    if (!init.ok) throw classifyHttp(init.status, json.message, "pre_commit", { headers: init.headers, provider: "linkedin", body: json });
    if (!json.value?.image || !json.value.uploadUrl) throw new PermanentError("linkedin: missing image upload instructions");
    assertAllowedHost(json.value.uploadUrl, ["linkedin.com", "licdn.com"]);
    const src = await safeFetch(imageUrl);
    if (!src.ok) { await src.body?.cancel(); throw new PermanentError(`linkedin: cannot fetch thumbnail (${src.status})`); }
    const bytes = await readProviderBody(src, 16 * 1024 * 1024);
    const put = await fetch(json.value.uploadUrl, { method: "PUT", redirect: "error", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/octet-stream" }, body: bytes });
    const failure = !put.ok ? await put.json().catch(() => undefined) : undefined;
    if (put.ok) await put.body?.cancel();
    if (!put.ok) throw classifyHttp(put.status, failure?.message ?? "linkedin: thumbnail upload failed", "pre_commit", { headers: put.headers, provider: "linkedin", body: failure });
    thumbnail = json.value.image;
  }
  const post = await fetch(`${REST}/posts`, { method: "POST", headers, body: JSON.stringify({
    author, commentary: request.caption ?? "", visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { article: { source: request.options!.articleUrl, title: request.title,
      ...(request.caption ? { description: request.caption } : {}), ...(thumbnail ? { thumbnail } : {}) } },
    lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
  }) });
  const id = post.headers.get("x-restli-id");
  const failure = !post.ok ? await post.json().catch(() => undefined) : undefined;
  if (post.ok) await post.body?.cancel();
  if (!post.ok || !id) throw classifyHttp(post.status, failure?.message ?? "linkedin: article post failed", "commit_uncertain", { headers: post.headers, provider: "linkedin", body: failure });
  return { providerHandle: id };
}

async function publishVideo(accessToken: string, owner: string, caption: string, url: string): Promise<PublishHandle> {
  const size = await sourceSize(url, Math.min(500 * 1024 * 1024, Number(process.env.PROVIDER_DOWNLOAD_MAX_BYTES ?? process.env.MEDIA_MAX_BYTES ?? 4 * 1024 ** 3)));
  const headers = restHeaders(accessToken);
  const init = await fetch("https://api.linkedin.com/rest/videos?action=initializeUpload", { method: "POST", headers, body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } }) });
  const json = await init.json().catch(() => ({})) as { message?: string; value?: { video: string; uploadToken?: string; uploadInstructions: { firstByte: number; lastByte: number; uploadUrl: string }[] } };
  if (!init.ok) throw classifyHttp(init.status, json.message ?? "linkedin: video initialization failed", "pre_commit", { headers: init.headers, provider: "linkedin", body: json });
  const value = json.value;
  if (!value?.video || !Array.isArray(value.uploadInstructions) || !value.uploadInstructions.length) throw new PermanentError("linkedin: missing upload instructions");
  const ids: string[] = [];
  let next = 0;
  for (const part of value.uploadInstructions) {
    if (part.firstByte !== next) throw new PermanentError("linkedin: invalid upload instructions");
    assertAllowedHost(part.uploadUrl, ["linkedin.com", "licdn.com"]);
    const bytes = await sourceRange(url, part.firstByte, part.lastByte, size);
    const put = await fetch(part.uploadUrl, { method: "PUT", redirect: "error", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes });
    const failure = !put.ok ? await put.json().catch(() => undefined) : undefined;
    if (put.ok) await put.body?.cancel();
    if (!put.ok) throw classifyHttp(put.status, failure?.message ?? "linkedin: video part failed", "pre_commit", { headers: put.headers, provider: "linkedin", body: failure });
    const etag = put.headers.get("etag");
    if (!etag) throw new PermanentError("linkedin: missing video part ID");
    ids.push(etag.replace(/^"|"$/g, "")); next = part.lastByte + 1;
  }
  if (next !== size) throw new PermanentError("linkedin: incomplete upload instructions");
  const final = await fetch("https://api.linkedin.com/rest/videos?action=finalizeUpload", { method: "POST", headers, body: JSON.stringify({ finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: ids } }) });
  const finalFailure = !final.ok ? await final.json().catch(() => undefined) : undefined;
  if (final.ok) await final.body?.cancel();
  if (!final.ok) throw classifyHttp(final.status, finalFailure?.message ?? "linkedin: video finalization failed", "pre_commit", { headers: final.headers, provider: "linkedin", body: finalFailure });
  const post = await fetch("https://api.linkedin.com/rest/posts", { method: "POST", headers, body: JSON.stringify({ author: owner, commentary: caption, visibility: "PUBLIC", distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, content: { media: { id: value.video } }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false }) });
  const id = post.headers.get("x-restli-id");
  const failure = !post.ok ? await post.json().catch(() => undefined) : undefined;
  if (post.ok) await post.body?.cancel();
  if (!post.ok || !id) throw classifyHttp(post.status, failure?.message ?? "linkedin: video post failed", "commit_uncertain", { headers: post.headers, provider: "linkedin", body: failure });
  return { providerHandle: id };
}
