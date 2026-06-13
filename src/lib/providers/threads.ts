import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle } from "./types";
import { PermanentError } from "./errors";
import { classifyHttp } from "./http";
import { asString } from "./util";

const GRAPH = "https://graph.threads.net";

const CAPS: FormatCapability[] = [
  { format: "text", media: { min: 0, max: 0, kinds: [] }, caption: { maxLength: 500, required: true }, mediaIngestion: "pull_url" },
  { format: "image", media: { min: 1, max: 1, kinds: ["image"] }, caption: { maxLength: 500, required: false }, mediaIngestion: "pull_url" },
  { format: "video", media: { min: 1, max: 1, kinds: ["video"] }, caption: { maxLength: 500, required: false }, mediaIngestion: "pull_url" },
];

export const threadsProvider: Provider = {
  id: "threads",
  label: "Threads",
  capabilities: () => CAPS,
  connectionModes: () => ["oauth"],
  requiresTokenRefresh: () => true,

  oauthConfig() {
    const clientId = process.env.THREADS_CLIENT_ID;
    const clientSecret = process.env.THREADS_CLIENT_SECRET;
    if (!clientId || !clientSecret) return undefined;
    return {
      authorizeUrl: "https://threads.net/oauth/authorize",
      tokenUrl: "https://graph.threads.net/oauth/access_token",
      scopes: ["threads_basic", "threads_content_publish"],
      clientId,
      clientSecret,
      scopeSeparator: ",",
    };
  },

  // Threads long-lived tokens refresh in place (IG-style GET), no separate refresh token.
  async refreshToken(tokens: TokenSet): Promise<TokenSet> {
    const res = await fetch(
      `${GRAPH}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(tokens.accessToken)}`,
    );
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (!res.ok || !json.access_token) throw classifyHttp(res.status, json.error?.message);
    return {
      accessToken: json.access_token,
      refreshToken: tokens.refreshToken,
      expiresAt: json.expires_in
        ? new Date(Date.now() + json.expires_in * 1000).toISOString()
        : undefined,
    };
  },

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(
      `${GRAPH}/v1.0/me?fields=id&access_token=${encodeURIComponent(tokens.accessToken)}`,
    );
    const json = (await res.json().catch(() => ({}))) as { id?: unknown; error?: { message?: string } };
    if (!res.ok) throw classifyHttp(res.status, json.error?.message);
    const accountId = asString(json.id); // PSA51
    if (!accountId) throw classifyHttp(404, "no threads user");
    return { accountId };
  },

  async publish({ tokens, accountId, request, mediaUrls }): Promise<PublishHandle> {
    if (!["text", "image", "video"].includes(request.format)) {
      throw new PermanentError(`threads: unsupported format '${request.format}'`);
    }
    const mediaType = request.format === "text" ? "TEXT" : request.format.toUpperCase();
    const createBody = new URLSearchParams({
      media_type: mediaType,
      ...(request.caption ? { text: request.caption } : {}),
      ...(mediaUrls[0]
        ? { [request.format === "video" ? "video_url" : "image_url"]: mediaUrls[0] }
        : {}),
      access_token: tokens.accessToken,
    });
    const create = await fetch(`${GRAPH}/v1.0/${accountId}/threads`, { method: "POST", body: createBody });
    const created = (await create.json().catch(() => ({}))) as { id?: unknown; error?: { message?: string } };
    // PSA36: container-create is pre-commit — the thread isn't public until threads_publish below.
    const creationId = asString(created.id); // PSA51
    if (!create.ok || !creationId) throw classifyHttp(create.status, created.error?.message, "pre_commit");

    const pub = await fetch(`${GRAPH}/v1.0/${accountId}/threads_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: creationId, access_token: tokens.accessToken }),
    });
    const pubj = (await pub.json().catch(() => ({}))) as { id?: unknown; error?: { message?: string } };
    const handle = asString(pubj.id); // PSA51
    if (!pub.ok || !handle) throw classifyHttp(pub.status, pubj.error?.message);
    return { providerHandle: handle };
  },
};
