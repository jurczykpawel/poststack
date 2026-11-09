import { oauthCredentials } from "./oauth-credentials";
import { postUrlFor } from "@/lib/posts/post-url";
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

  async oauthConfig() {
    const { clientId, clientSecret } = await oauthCredentials("x");
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
      ...await oauthCredentials("x"),
      refreshToken: tokens.refreshToken ?? "",
      tokenAuthBasic: true,
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
    // handle = @username: unique per platform, so it reliably links a pre-migration handle-keyed
    // channel row to this account (used by the connect flow's reauth-orphan cleanup).
    return { accountId: id, displayName: json.data?.username, handle: json.data?.username };
  },

  async publish({ tokens, request }): Promise<PublishHandle> {
    if (request.format !== "text") {
      // Media (image/video) needs a prior chunked media upload (v1.1 media/upload INIT/APPEND/FINALIZE)
      // — not implemented yet. Fail LOUD rather than silently posting text and dropping the media.
      throw new PermanentError(`x: ${request.format} publishing not implemented (media chunked upload)`);
    }
    // AIDISC1: publish-worker-normalized boolean (see lib/ai-disclosure/mapping.ts). Goes on the
    // tweet-create call itself, not the (unimplemented) media-upload call above.
    const aiDisclosed =
      typeof request.options?.aiDisclosed === "boolean" ? request.options.aiDisclosed : undefined;
    const res = await fetch(`${API}/tweets`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        text: request.caption ?? "",
        ...(aiDisclosed !== undefined ? { made_with_ai: aiDisclosed } : {}),
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }; detail?: string };
    const handle = asString(json.data?.id); // PSA51: narrow before trusting
    if (!res.ok || !handle) throw classifyHttp(res.status, json.detail);
    return { providerHandle: handle, url: postUrlFor("twitter", handle) ?? undefined };
  },
};

/** Read or remove an already published X post. */
export async function xPlatformPost(tokens: TokenSet, id: string, method: "GET" | "DELETE") {
  if (!/^\d+$/.test(id)) throw new PermanentError("Invalid X post ID");
  const res = await fetch(`${API}/tweets/${id}`, {
    method, redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });
  if (method === "GET" && res.status === 404) return { exists: false, providerStatus: 404, platformPostId: id };
  try {
    if (!res.ok) throw classifyHttp(res.status, `X HTTP ${res.status}`);
    const json = await res.json() as {
      data?: { id?: string; deleted?: boolean };
      errors?: { type?: string; resource_id?: string; resource_type?: string }[];
    };
    if (!json.data && Array.isArray(json.errors) && json.errors.length > 0 && json.errors.every(problem =>
      problem?.type === "https://api.x.com/2/problems/resource-not-found" &&
      problem.resource_id === id && problem.resource_type === "tweet",
    )) return method === "GET" ? { exists: false, providerStatus: 404, platformPostId: id } : { deleted: true };
    if (method === "DELETE" && json.data?.deleted === true) return { deleted: true };
    if (method === "GET" && json.data?.id === id) return { exists: true, providerStatus: 200, platformPostId: id };
    throw new PermanentError("Unexpected X post response");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error("X operation failed"), { providerStatus: res.status });
  }
}
