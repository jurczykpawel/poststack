import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { PermanentError } from "./errors";
import { classifyHttp, oauth2Refresh } from "./http";
import { asString } from "./util";

const API = "https://api.twitter.com/2";

const CAPS: FormatCapability[] = [
  { format: "text", media: { min: 0, max: 0, kinds: [] }, caption: { maxLength: 280, required: true }, mediaIngestion: "chunked_upload" },
  { format: "image", media: { min: 1, max: 4, kinds: ["image"] }, caption: { maxLength: 280, required: false }, mediaIngestion: "chunked_upload" },
  { format: "video", media: { min: 1, max: 1, kinds: ["video"] }, caption: { maxLength: 280, required: false }, mediaIngestion: "chunked_upload" },
];

export const xProvider: Provider = {
  id: "x",
  label: "X (Twitter)",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true,

  oauthConfig() {
    const clientId = process.env.X_CLIENT_ID;
    const clientSecret = process.env.X_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: `${API}/oauth2/token`,
      scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
      clientId,
      clientSecret,
      usePkce: true, // X OAuth2 requires PKCE
      tokenAuthBasic: true, // confidential client: Basic auth on the token endpoint
    };
  },

  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    // X rotates the refresh token on each use; oauth2Refresh stores the new one.
    return oauth2Refresh({
      tokenUrl: `${API}/oauth2/token`,
      clientId: process.env.X_CLIENT_ID ?? "",
      clientSecret: process.env.X_CLIENT_SECRET ?? "",
      refreshToken: tokens.refreshToken ?? "",
    });
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(`${API}/users/me`, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    const json = (await res.json().catch(() => ({}))) as {
      data?: { id?: unknown; username?: string };
      detail?: string;
    };
    if (!res.ok) throw classifyHttp(res.status, json.detail);
    const id = asString(json.data?.id); // PSA55 (PSA51 class)
    if (!id) throw classifyHttp(404, "no x user");
    return { accountId: id, displayName: json.data?.username };
  },

  async publish({ tokens, request }): Promise<PublishHandle> {
    if (!["text", "image", "video"].includes(request.format)) {
      throw new PermanentError(`x: unsupported format '${request.format}'`);
    }
    // NOTE: media (image/video) requires a prior chunked media upload — flagged for live work.
    const res = await fetch(`${API}/tweets`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ text: request.caption ?? "" }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }; detail?: string };
    const handle = asString(json.data?.id); // PSA51: narrow before trusting
    if (!res.ok || !handle) throw classifyHttp(res.status, json.detail);
    return { providerHandle: handle };
  },
};
