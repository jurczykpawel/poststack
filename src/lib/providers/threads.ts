import { oauthCredentials } from "./oauth-credentials";
import type { TokenSet } from "./types";
import type { AccountInfo, FormatCapability, Provider, PublishHandle, PublishStatus } from "./types";
import { PermanentError, TokenInvalidError } from "./errors";
import { classifyHttp } from "./http";
import { asString } from "./util";

const GRAPH = "https://graph.threads.net";

// Meta collection (checked 2026-11-11): 2–20 images/videos, including mixed media.
// https://github.com/fbsamples/threads_api/blob/main/postman/threads-api.postman_collection.json
const CAPS: FormatCapability[] = [
  { format: "carousel", media: { min: 2, max: 20, kinds: ["image", "video"] }, caption: { maxLength: 500, required: false }, mediaIngestion: "pull_url" },
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

  async oauthConfig() {
    const { clientId, clientSecret } = await oauthCredentials("threads");
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
      error?: { message?: string; code?: number };
    };
    if (res.status < 500 && json.error?.code === 190) throw new TokenInvalidError("Threads access token expired — reconnect required");
    if (!res.ok || !json.access_token) throw classifyHttp(res.status, json.error?.message, "commit_uncertain", { headers: res.headers, provider: "threads", body: json });
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
      `${GRAPH}/v1.0/me?fields=id,username&access_token=${encodeURIComponent(tokens.accessToken)}`,
    );
    const json = (await res.json().catch(() => ({}))) as {
      id?: unknown;
      username?: unknown;
      error?: { message?: string };
    };
    if (!res.ok) throw classifyHttp(res.status, json.error?.message, "commit_uncertain", { headers: res.headers, provider: "threads", body: json });
    const accountId = asString(json.id); // PSA51
    if (!accountId) throw classifyHttp(404, "no threads user");
    // handle = @username: unique per platform; links a pre-migration handle-keyed row to this account
    // for the connect flow's reauth-orphan cleanup.
    const username = asString(json.username) || undefined;
    return { accountId, displayName: username, handle: username };
  },

  async publish({ accountId, request, mediaUrls, mediaKinds }): Promise<PublishHandle> {
    if (!["text", "image", "video", "carousel"].includes(request.format)) throw new PermanentError(`threads: unsupported format '${request.format}'`);
    if (request.format === "carousel" && (mediaUrls.length < 2 || mediaUrls.length > 20)) throw new PermanentError("Threads carousel requires 2–20 media items");
    if (request.format === "carousel" && (mediaKinds?.length !== mediaUrls.length || mediaKinds.some(k => !["image", "video"].includes(k)))) throw new PermanentError("Threads carousel requires a registry kind for every item");
    const state: ThreadsPublish = { accountId, format: request.format, caption: request.caption, urls: mediaUrls, kinds: mediaKinds ?? [], children: [], stage: "ready" };
    // The worker persists this handle before the first external mutation.
    return { processing: true, providerHandle: JSON.stringify(state) };
  },
  publishStatus: pollThreads,
};

type ThreadsPublish = {
  accountId: string; format: string; caption?: string; urls: string[]; kinds: string[];
  children: string[]; container?: string; postId?: string;
  stage: "ready" | "creating" | "publishing" | "published";
};

async function pollThreads(tokens: TokenSet, handle: PublishHandle, saveHandle?: (handle: string) => Promise<void>): Promise<PublishStatus> {
  const state = JSON.parse(handle.providerHandle) as ThreadsPublish;
  const checkpoint = async () => {
    if (!saveHandle) throw new Error("Threads processing requires durable checkpoints");
    await saveHandle(JSON.stringify(state));
  };
  const published = (): PublishStatus => ({ state: "published", providerHandle: state.postId ?? state.container, postId: state.postId });
  if (state.stage === "published") return published();
  if (state.stage === "creating") return { state: "failed", error: "Threads container creation was interrupted; review before publishing again" };
  const call = async (path: string, body?: Record<string, string>) => {
    const res = await fetch(`${GRAPH}/v1.0/${path}`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      ...(body ? { method: "POST", body: new URLSearchParams(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({})) as { id?: unknown; status?: string; error_message?: string; error?: { message?: string } };
    if (!res.ok || json.error) throw classifyHttp(res.status, json.error?.message, "commit_uncertain", { headers: res.headers, provider: "threads", body: json });
    return json;
  };
  const create = async (body: Record<string, string>) => {
    state.stage = "creating";
    await checkpoint();
    const json = await call(`${encodeURIComponent(state.accountId)}/threads`, body);
    const id = asString(json.id);
    if (!id) throw new PermanentError("Threads container response has no id");
    state.stage = "ready";
    return id;
  };
  const status = async (id: string) => {
    const json = await call(`${encodeURIComponent(id)}?fields=status,error_message`);
    if (json.status === "ERROR" || json.status === "EXPIRED") throw new PermanentError(`Threads container ${json.status}: ${json.error_message || "media processing failed"}`);
    if (!["FINISHED", "IN_PROGRESS", "PUBLISHED"].includes(json.status ?? "")) throw new PermanentError("Threads container returned an unknown status");
    return json.status;
  };
  try {
    if (!state.container) {
      if (state.format === "carousel") {
        for (let i = state.children.length; i < state.urls.length; i++) {
          const video = state.kinds[i] === "video";
          state.children.push(await create({ media_type: video ? "VIDEO" : "IMAGE", [video ? "video_url" : "image_url"]: state.urls[i]!, is_carousel_item: "true" }));
          await checkpoint();
        }
        for (const id of state.children) if (await status(id) !== "FINISHED") return { state: "accepted" };
      }
      state.container = await create({ media_type: state.format.toUpperCase(),
        ...(state.caption ? { text: state.caption } : {}),
        ...(state.format === "carousel" ? { children: state.children.join(",") } : state.urls[0] ? { [state.format === "video" ? "video_url" : "image_url"]: state.urls[0] } : {}),
      });
      await checkpoint();
      return { state: "accepted" };
    }
    const current = await status(state.container);
    if (current === "PUBLISHED") { state.stage = "published"; await checkpoint(); return published(); }
    if (current !== "FINISHED" || state.stage === "publishing") return { state: "accepted" };
    state.stage = "publishing";
    await checkpoint();
    const json = await call(`${encodeURIComponent(state.accountId)}/threads_publish`, { creation_id: state.container });
    state.postId = asString(json.id) || undefined;
    if (!state.postId) return { state: "accepted" };
    state.stage = "published";
    await checkpoint();
    return published();
  } catch (err) {
    if (err instanceof PermanentError) return { state: "failed", error: err.message };
    throw err;
  }
}
