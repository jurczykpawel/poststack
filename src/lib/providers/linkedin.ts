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

  async publish({ tokens, accountId, request }): Promise<PublishHandle> {
    if (!["text", "image", "video", "article"].includes(request.format)) {
      throw new PermanentError(`linkedin: unsupported format '${request.format}'`);
    }
    // NOTE: media/article assets need a prior register-upload step — flagged for live work.
    const res = await fetch(`${API}/ugcPosts`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        author: `urn:li:person:${accountId}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: request.caption ?? "" },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: unknown; message?: string };
    const handle = asString(json.id); // PSA51
    if (!res.ok || !handle) throw classifyHttp(res.status, json.message);
    return { providerHandle: handle };
  },
};
