import type { TokenSet } from "./types";
import type {
  AccountInfo,
  FormatCapability,
  Provider,
  PublishHandle,
  SourceInfo,
  SubAccount,
} from "./types";
import { PermanentError, TokenInvalidError, TransientError, type PublishPhase } from "./errors";
import { GRAPH_API_BASE, IG_GRAPH_BASE } from "@/lib/platforms/constants";
import { getConfig } from "@/lib/settings/config";
import { safeFetch } from "@/lib/media/ssrf";
import { assertAllowedHost } from "./follow";
import { readProviderCover } from "./download";
import { asString } from "./util";

// PSA50: hosts Meta returns for paging + resumable uploads (graph.facebook.com, rupload.facebook.com, …).
const META_HOSTS = ["facebook.com", "fbcdn.net"];

/**
 * PSA10: debug_token MUST use this app's token (`app_id|app_secret`), never the master token itself.
 * Without app creds the only option would be to echo the master token, and then debug_token merely
 * confirms it's *a* valid Meta token — ANY Meta token from ANY app would pass and PostStack would mint
 * + persist Page tokens from it. So we hard-require app creds for the managed connection.
 */
async function debugTokenAccessToken(): Promise<string> {
  const id = await getConfig("META_APP_ID");
  const secret = await getConfig("META_APP_SECRET");
  if (!id || !secret) {
    throw new TokenInvalidError("Meta managed connection requires META_APP_ID + META_APP_SECRET");
  }
  return `${id}|${secret}`;
}

export function classifyMetaError(
  status: number,
  error?: { code?: number; message?: string },
  phase: PublishPhase = "commit_uncertain", // PSA36
) {
  const code = error?.code;
  // Token-invalid is signalled by a Meta error CODE (190 = invalid/expired, 102 = session expired,
  // 467 = invalid token) — NOT by a bare HTTP 400/401. Meta returns 400 for many benign request
  // errors (e.g. #100 "The parameter image_url is required"); classifying those as a token failure
  // wrongly flips a healthy channel into needs_reauth (the messaging path already keys on code 190
  // only — see isMetaTokenError). Keep both layers consistent.
  if (code === 190 || code === 102 || code === 467) {
    return new TokenInvalidError(`Meta token invalid: ${error?.message ?? status}`);
  }
  if (status >= 500) return new TransientError(`Meta transient: ${status}`, phase);
  return new PermanentError(`Meta publish failed (${status}): ${error?.message ?? "unknown"}`);
}

// Single source of truth for the Graph API version (constants.ts). The publishing layer MUST stay in
// lockstep with the inbound/messaging layer — a divergent hardcoded version is exactly the drift the
// version-bump probe (VPROBE1) exists to catch.
const GRAPH = GRAPH_API_BASE;

/**
 * IGFU1: choose the Instagram publish transport. A channel connected ONLY via Instagram Business
 * Login carries an IG-Login token (`messagingToken`) and an EMPTY Facebook page token — publish via
 * `graph.instagram.com` (IG_GRAPH_BASE) with that token, exactly the way IGML4's `messagingTransport`
 * routes the messaging surface. Any channel that still has a Facebook page token keeps publishing on
 * `graph.facebook.com` with that token, byte-for-byte unchanged (the managed / FB-login path). Only
 * the Instagram media-container flow uses this — the Facebook-Page branch above is never affected.
 */
function igPublishTransport(tokens: TokenSet): { base: string; token: string } {
  if (tokens.messagingToken && !tokens.accessToken) {
    return { base: IG_GRAPH_BASE, token: tokens.messagingToken };
  }
  return { base: GRAPH, token: tokens.accessToken };
}

const CAPABILITIES: FormatCapability[] = [
  {
    format: "reel",
    media: { min: 1, max: 1, kinds: ["video"] },
    video: { maxDurationSec: 90, aspectRatios: ["9:16"] },
    caption: { maxLength: 2200, required: false },
    mediaIngestion: "pull_url",
  },
  {
    format: "feed_post",
    media: { min: 1, max: 1, kinds: ["image", "video"] },
    caption: { maxLength: 2200, required: false },
    mediaIngestion: "pull_url",
  },
  {
    format: "story",
    media: { min: 1, max: 1, kinds: ["image", "video"] },
    mediaIngestion: "pull_url",
  },
  {
    format: "carousel",
    media: { min: 2, max: 10, kinds: ["image", "video"] },
    caption: { maxLength: 2200, required: false },
    mediaIngestion: "pull_url",
  },
];

/** Set a custom FB video thumbnail (best-effort — video is already created). */
async function setFacebookThumbnail(
  videoId: string,
  coverUrl: string | undefined,
  accessToken: string,
): Promise<void> {
  if (!coverUrl) return;
  try {
    const img = await safeFetch(coverUrl); // SSRF guard — coverUrl is caller-supplied
    if (!img.ok) {
      await img.body?.cancel().catch(() => {}); // release the streamed socket — body is never read here
      return;
    }
    const form = new FormData();
    const bytes = await readProviderCover(img); // PSA52: cap the cover download
    form.set("source", new Blob([bytes]));
    form.set("is_preferred", "true");
    form.set("access_token", accessToken);
    await fetch(`${GRAPH}/${videoId}/thumbnails`, { method: "POST", body: form });
  } catch {
    /* best-effort */
  }
}

/** Poll an IG media container until it reports FINISHED (images resolve fast; bounded by env). Throws
 *  PermanentError on ERROR and TransientError if it's still processing after the window (pre_commit —
 *  nothing is public until media_publish, so the caller may safely re-run). */
async function pollContainerFinished(containerId: string, encodedToken: string, base: string = GRAPH): Promise<void> {
  const attempts = Number(process.env.META_PUBLISH_POLL_ATTEMPTS ?? 60);
  const delayMs = Number(process.env.META_PUBLISH_POLL_DELAY_MS ?? 3000);
  for (let i = 0; i < attempts; i++) {
    const st = await fetch(`${base}/${containerId}?fields=status_code&access_token=${encodedToken}`);
    const stj = (await st.json().catch(() => ({}))) as { status_code?: string };
    if (stj.status_code === "FINISHED") return;
    if (stj.status_code === "ERROR") throw new PermanentError("Meta story container processing failed");
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new TransientError("Meta story container still processing after poll window", "pre_commit");
}

export const metaProvider: Provider = {
  id: "meta",
  label: "Meta (Facebook / Instagram)",
  capabilities: () => CAPABILITIES,
  connectionModes: () => ["manual_token", "oauth"],
  // Meta long-lived / System User tokens are not refreshed via a grant; reconnect instead.
  requiresTokenRefresh: () => false,

  async healthCheck(tokens: TokenSet): Promise<AccountInfo> {
    const res = await fetch(
      `${GRAPH}/me?fields=id,name,picture.width(96).height(96)&access_token=${encodeURIComponent(tokens.accessToken)}`,
    );
    if (res.ok) {
      const data = (await res.json()) as { id?: unknown; name?: string; picture?: { data?: { url?: string } } };
      const accountId = asString(data.id); // PSA51
      if (!accountId) throw new PermanentError("Meta health-check returned no account id");
      return { accountId, displayName: data.name, avatarUrl: data.picture?.data?.url };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: number; message?: string };
    };
    const code = body.error?.code;
    if (res.status === 400 || res.status === 401 || code === 190 || code === 102 || code === 467) {
      throw new TokenInvalidError(`Meta token invalid: ${body.error?.message ?? res.status}`);
    }
    throw new TransientError(`Meta health-check transient failure: ${res.status}`);
  },

  // Plan 05+: Meta tokens are not refreshable; reconnect is required.
  async refreshToken(): Promise<TokenSet> {
    throw new TokenInvalidError("Meta tokens are not refreshable — reconnect required");
  },

  // Plan 10: managed connection — one master token mints + manages per-Page tokens.
  supportsSources: () => true,

  async inspectSource(master: TokenSet): Promise<SourceInfo> {
    const at = encodeURIComponent(await debugTokenAccessToken()); // throws unless app creds are configured
    const res = await fetch(
      `${GRAPH}/debug_token?input_token=${encodeURIComponent(master.accessToken)}&access_token=${at}`,
    );
    const body = (await res.json().catch(() => ({}))) as {
      data?: {
        app_id?: string;
        type?: string;
        user_id?: string;
        data_access_expires_at?: number;
        scopes?: string[];
        is_valid?: boolean;
      };
      error?: { code?: number; message?: string };
    };
    if (!res.ok || !body.data || body.data.is_valid === false) {
      if (res.ok) throw new TokenInvalidError("Meta master token is not valid");
      throw classifyMetaError(res.status, body.error);
    }
    // PSA10: the token must belong to THIS app, else a foreign-app token could mint our Page tokens.
    if (body.data.app_id !== process.env.META_APP_ID) {
      throw new TokenInvalidError("Meta token belongs to a different app");
    }
    const dae = body.data.data_access_expires_at;
    return {
      providerAccountId: body.data.user_id ?? "",
      type: body.data.type,
      dataAccessExpiresAt: dae && dae > 0 ? new Date(dae * 1000).toISOString() : undefined,
      scopes: body.data.scopes,
    };
  },

  async enumerateSubAccounts(master: TokenSet): Promise<SubAccount[]> {
    const token = encodeURIComponent(master.accessToken);
    let next: string | undefined = `${GRAPH}/me/accounts?fields=name,access_token,instagram_business_account%7Bid,username%7D&limit=100&access_token=${token}`;
    const subs: SubAccount[] = [];
    for (let guard = 0; next && guard < 20; guard++) {
      assertAllowedHost(next, META_HOSTS); // PSA50: the paging URL carries the token in its query
      const res = await fetch(next);
      const body = (await res.json().catch(() => ({}))) as {
        data?: Array<{
          id?: unknown;
          name?: string;
          access_token?: string;
          instagram_business_account?: { id?: unknown; username?: string };
        }>;
        paging?: { next?: string };
        error?: { code?: number; message?: string };
      };
      if (!res.ok || !body.data) throw classifyMetaError(res.status, body.error);
      for (const p of body.data) {
        if (!p.access_token) continue;
        const pageId = asString(p.id); // PSA55 (PSA51 class): skip a malformed page entry
        if (!pageId) continue;
        const pageToken: TokenSet = { accessToken: p.access_token };
        subs.push({
          platform: "meta",
          providerAccountId: pageId,
          displayName: p.name,
          token: pageToken,
          metadata: { subKind: "facebook_page" },
        });
        const igId = asString(p.instagram_business_account?.id);
        if (igId) {
          subs.push({
            platform: "meta",
            providerAccountId: igId,
            displayName: p.instagram_business_account?.username ?? p.name,
            token: pageToken, // IG publishes with its linked Page's token
            metadata: { subKind: "instagram" },
          });
        }
      }
      next = body.paging?.next;
    }
    return subs;
  },

  async publish(args): Promise<PublishHandle> {
    const { tokens, accountId, request, mediaUrls } = args;
    const token = encodeURIComponent(tokens.accessToken);
    const url = mediaUrls[0];

    // Facebook Page (METAPUB1): route by channelMetadata.subKind, or options.target override.
    // FB pulls from file_url (no domain verification). published=false = unpublished (library).
    const sub = args.channelMetadata?.subKind;
    const isFacebook =
      sub === "facebook_page" ||
      request.options?.target === "facebook" ||
      request.options?.target === "facebook_page";
    if (isFacebook) {
      const published = request.options?.published !== false; // default true
      const coverUrl = typeof request.options?.coverUrl === "string" ? request.options.coverUrl : undefined;

      if (request.format === "reel") {
        // FB Reels: start -> upload (file_url) -> finish
        const start = await fetch(
          `${GRAPH}/${accountId}/video_reels?upload_phase=start&access_token=${token}`,
          { method: "POST" },
        );
        const sj = (await start.json().catch(() => ({}))) as {
          video_id?: string;
          upload_url?: string;
          error?: { code?: number; message?: string };
        };
        if (!start.ok || !sj.video_id || !sj.upload_url) throw classifyMetaError(start.status, sj.error);
        assertAllowedHost(sj.upload_url, META_HOSTS); // PSA50: don't send the OAuth token to a non-Meta host
        const up = await fetch(sj.upload_url, {
          method: "POST",
          headers: { authorization: `OAuth ${tokens.accessToken}`, file_url: url ?? "" },
        });
        if (!up.ok) throw classifyMetaError(up.status, undefined);
        const finUrl =
          `${GRAPH}/${accountId}/video_reels?upload_phase=finish&video_id=${sj.video_id}` +
          `&video_state=${published ? "PUBLISHED" : "DRAFT"}` +
          `${request.caption ? `&description=${encodeURIComponent(request.caption)}` : ""}` +
          `&access_token=${token}`;
        const fin = await fetch(finUrl, { method: "POST" });
        const fj = (await fin.json().catch(() => ({}))) as {
          success?: boolean;
          post_id?: unknown;
          error?: { code?: number; message?: string };
        };
        if (!fin.ok || fj.success === false) throw classifyMetaError(fin.status, fj.error);
        const handle = asString(fj.post_id) ?? asString(sj.video_id); // PSA51
        if (!handle) throw classifyMetaError(fin.status, fj.error);
        await setFacebookThumbnail(sj.video_id, coverUrl, tokens.accessToken);
        return { providerHandle: handle };
      }

      if (request.format === "feed_post" && request.options?.mediaKind === "image") {
        const body = new URLSearchParams({
          url: url ?? "",
          ...(request.caption ? { caption: request.caption } : {}),
          published: String(published),
          access_token: tokens.accessToken,
        });
        const res = await fetch(`${GRAPH}/${accountId}/photos`, { method: "POST", body });
        const j = (await res.json().catch(() => ({}))) as {
          id?: unknown;
          post_id?: unknown;
          error?: { code?: number; message?: string };
        };
        const handle = asString(j.post_id) ?? asString(j.id); // PSA51
        if (!res.ok || !handle) throw classifyMetaError(res.status, j.error);
        return { providerHandle: handle };
      }

      // default FB: video via file_url
      const body = new URLSearchParams({
        file_url: url ?? "",
        ...(request.caption ? { description: request.caption } : {}),
        published: String(published),
        access_token: tokens.accessToken,
      });
      const res = await fetch(`${GRAPH}/${accountId}/videos`, { method: "POST", body });
      const j = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        error?: { code?: number; message?: string };
      };
      const handle = asString(j.id); // PSA51
      if (!res.ok || !handle) throw classifyMetaError(res.status, j.error);
      await setFacebookThumbnail(handle, coverUrl, tokens.accessToken); // best-effort cover
      return { providerHandle: handle };
    }

    if (request.format === "reel" || request.format === "feed_post") {
      const isReel = request.format === "reel";
      // IGFU1: route the IG container flow to graph.instagram.com with the IG-Login token when the
      // channel has no Facebook page token; otherwise stay on graph.facebook.com with the FB token.
      const { base: igBase, token: igRawToken } = igPublishTransport(tokens);
      const igToken = encodeURIComponent(igRawToken);
      // Cover/thumbnail (reels): cover_url (public image) wins over thumb_offset (frame ms).
      const coverUrl = typeof request.options?.coverUrl === "string" ? request.options.coverUrl : undefined;
      const thumbOffset =
        typeof request.options?.thumbOffset === "number" ? request.options.thumbOffset : undefined;
      // 1) create media container. IG image feed posts take `image_url` (Meta rejects a bare `url`
      // with #100 "The parameter image_url is required" — same param the Story path uses); reels take
      // `video_url` with media_type REELS.
      const createBody = new URLSearchParams({
        ...(isReel ? { media_type: "REELS", video_url: url ?? "" } : { image_url: url ?? "" }),
        ...(request.caption ? { caption: request.caption } : {}),
        ...(isReel && coverUrl ? { cover_url: coverUrl } : {}),
        ...(isReel && !coverUrl && thumbOffset !== undefined ? { thumb_offset: String(thumbOffset) } : {}),
        access_token: igRawToken,
      });
      const create = await fetch(`${igBase}/${accountId}/media`, { method: "POST", body: createBody });
      const created = (await create.json().catch(() => ({}))) as {
        id?: unknown;
        error?: { code?: number; message?: string };
      };
      // PSA36: container-create is pre-commit — nothing is public until step 3, so a transient here is safe to retry.
      const containerId = asString(created.id); // PSA51: a non-string id would coerce to "[object Object]" downstream
      if (!create.ok || !containerId) throw classifyMetaError(create.status, created.error, "pre_commit");

      // 2) poll container status until FINISHED (IG processes async — observed ~60-90s for a reel).
      const attempts = Number(process.env.META_PUBLISH_POLL_ATTEMPTS ?? 60);
      const delayMs = Number(process.env.META_PUBLISH_POLL_DELAY_MS ?? 3000);
      let finished = false;
      for (let i = 0; i < attempts; i++) {
        const st = await fetch(`${igBase}/${containerId}?fields=status_code&access_token=${igToken}`);
        const stj = (await st.json().catch(() => ({}))) as { status_code?: string };
        if (stj.status_code === "FINISHED") {
          finished = true;
          break;
        }
        if (stj.status_code === "ERROR") throw new PermanentError("Meta container processing failed");
        await new Promise((r) => setTimeout(r, delayMs)); // back off; don't hammer
      }
      // Never publish a half-processed container — make the worker retry later instead. Pre-commit
      // (we never reached step 3), so the retry can safely re-run the whole publish (PSA36).
      if (!finished) throw new TransientError("Meta container still processing after poll window", "pre_commit");

      // 3) publish the container
      const pub = await fetch(`${igBase}/${accountId}/media_publish`, {
        method: "POST",
        body: new URLSearchParams({ creation_id: containerId, access_token: igRawToken }),
      });
      const pubj = (await pub.json().catch(() => ({}))) as {
        id?: unknown;
        error?: { code?: number; message?: string };
      };
      const handle = asString(pubj.id); // PSA51
      if (!pub.ok || !handle) throw classifyMetaError(pub.status, pubj.error);
      return { providerHandle: handle };
    }

    throw new PermanentError(`meta.publish does not support format '${request.format}' yet`);
  },

  // STORY1: publish a pre-rendered 9:16 image as a Story. The image lives at a public URL (our CAS
  // bucket); the platform pulls it. No interactive overlays are possible via the API — the card is
  // composed server-side (StoryRenderer) and published flat.
  async publishStory(args): Promise<PublishHandle> {
    const { tokens, accountId, mediaUrl } = args;
    const isFacebook = args.channelMetadata?.subKind === "facebook_page";

    if (isFacebook) {
      // FB Page Story (photo): upload an UNPUBLISHED photo, then promote it to a photo story. The
      // story image must NOT already be in a published post — our card is a fresh, separate file.
      const photoRes = await fetch(`${GRAPH}/${accountId}/photos`, {
        method: "POST",
        body: new URLSearchParams({ url: mediaUrl, published: "false", access_token: tokens.accessToken }),
      });
      const photoJson = (await photoRes.json().catch(() => ({}))) as {
        id?: unknown;
        error?: { code?: number; message?: string };
      };
      const photoId = asString(photoJson.id);
      // Photo upload is pre-commit — a story isn't visible until photo_stories below.
      if (!photoRes.ok || !photoId) throw classifyMetaError(photoRes.status, photoJson.error, "pre_commit");

      const storyRes = await fetch(`${GRAPH}/${accountId}/photo_stories`, {
        method: "POST",
        body: new URLSearchParams({ photo_id: photoId, access_token: tokens.accessToken }),
      });
      const storyJson = (await storyRes.json().catch(() => ({}))) as {
        success?: boolean;
        post_id?: unknown;
        id?: unknown;
        error?: { code?: number; message?: string };
      };
      const handle = asString(storyJson.post_id) ?? asString(storyJson.id);
      if (!storyRes.ok || storyJson.success === false || !handle) throw classifyMetaError(storyRes.status, storyJson.error);
      return { providerHandle: handle };
    }

    // Instagram Story: create a STORIES container from the image, poll, then publish.
    // IGFU1: same single-login routing as the feed/reel path — graph.instagram.com + IG-Login token
    // for an IG-Login-only channel; graph.facebook.com + FB page token otherwise (unchanged).
    const { base: igBase, token: igRawToken } = igPublishTransport(tokens);
    const igToken = encodeURIComponent(igRawToken);
    const create = await fetch(`${igBase}/${accountId}/media`, {
      method: "POST",
      body: new URLSearchParams({ media_type: "STORIES", image_url: mediaUrl, access_token: igRawToken }),
    });
    const created = (await create.json().catch(() => ({}))) as {
      id?: unknown;
      error?: { code?: number; message?: string };
    };
    const containerId = asString(created.id);
    if (!create.ok || !containerId) throw classifyMetaError(create.status, created.error, "pre_commit");

    await pollContainerFinished(containerId, igToken, igBase);

    const pub = await fetch(`${igBase}/${accountId}/media_publish`, {
      method: "POST",
      body: new URLSearchParams({ creation_id: containerId, access_token: igRawToken }),
    });
    const pubj = (await pub.json().catch(() => ({}))) as {
      id?: unknown;
      error?: { code?: number; message?: string };
    };
    const handle = asString(pubj.id);
    if (!pub.ok || !handle) throw classifyMetaError(pub.status, pubj.error);
    return { providerHandle: handle };
  },
};
