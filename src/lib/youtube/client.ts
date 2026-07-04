// Thin YouTube Data API v3 client for comment automation. Quota-conscious by design:
//  - reads cost 1 unit; a conditional GET that returns 304 Not Modified costs ZERO (the idle case),
//  - there is NO publishedAfter filter on commentThreads.list, so "since" is done client-side by
//    walking order=time (newest first) and stopping at the cursor,
//  - pagination is capped so a huge first backlog can't burn the daily quota in one poll.
// comments.insert (reply) costs ~50 units, so replies are driven by rules, never bulk.

const YT_API = "https://www.googleapis.com/youtube/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
// force-ssl is required to read + reply to comments as the channel owner.
export const YOUTUBE_OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const TIMEOUT_MS = 15_000;

/** Build the Google consent URL. access_type=offline + prompt=consent guarantee a refresh_token.
 *  We deliberately omit include_granted_scopes: this Google client may be shared with other tools
 *  (Gmail/Drive/Photos), and unioning their previously-granted scopes would both scare the user with a
 *  huge consent screen and over-grant the issued token. Connecting a channel needs YouTube only. */
export function googleAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/** Exchange an authorization code for tokens (access + refresh). */
export async function exchangeGoogleCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YouTubeApiError(res.status, `Google code exchange ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) throw new YouTubeApiError(500, "Google code exchange returned no access_token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
  };
}

export interface YtComment {
  /** commentThread id. */
  threadId: string;
  /** topLevelComment id — the parentId to reply to via comments.insert. */
  commentId: string;
  videoId: string | null;
  authorChannelId: string | null;
  authorName: string | null;
  text: string;
  publishedAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface PollResult {
  /** 304 Not Modified — nothing changed since `etag`; zero quota spent. */
  notModified: boolean;
  /** ETag of the newest page, to send as If-None-Match next time. */
  etag?: string;
  /** New comments (publishedAt strictly after `sincePublishedAt`), newest-first as returned. */
  comments: YtComment[];
  /** Quota units actually spent (pages fetched that returned 200). For observability. */
  quotaSpent: number;
}

interface RawThread {
  etag?: string;
  id: string;
  snippet?: {
    videoId?: string;
    topLevelComment?: {
      id: string;
      snippet?: {
        authorDisplayName?: string;
        authorChannelId?: { value?: string };
        textOriginal?: string;
        textDisplay?: string;
        publishedAt?: string;
        updatedAt?: string;
      };
    };
  };
}
interface ThreadListResponse {
  etag?: string;
  nextPageToken?: string;
  items?: RawThread[];
}

function mapThread(t: RawThread): YtComment | null {
  const top = t.snippet?.topLevelComment;
  const s = top?.snippet;
  if (!top?.id || !s) return null;
  return {
    threadId: t.id,
    commentId: top.id,
    videoId: t.snippet?.videoId ?? null,
    authorChannelId: s.authorChannelId?.value ?? null,
    authorName: s.authorDisplayName ?? null,
    text: s.textOriginal ?? s.textDisplay ?? "",
    publishedAt: s.publishedAt ?? new Date(0).toISOString(),
    updatedAt: s.updatedAt ?? s.publishedAt ?? new Date(0).toISOString(),
  };
}

/** A YouTube API error that carries the HTTP status (e.g. 401 → token refresh, 403 → quota). */
export class YouTubeApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "YouTubeApiError";
  }
}

export interface PollOptions {
  /** The connected channel id (commentThreads are pulled for allThreadsRelatedToChannelId). */
  channelId: string;
  accessToken: string;
  /** Previous ETag → conditional request; a 304 means nothing new (no quota). */
  etag?: string | null;
  /** Stop once a comment's publishedAt is <= this (the cursor). Null = first poll (one page only). */
  sincePublishedAt?: string | null;
  /** Page cap to bound quota (each page = 1 unit). Default 5 (= up to 500 comments / poll). */
  maxPages?: number;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Poll new top-level comments across a channel. Sends If-None-Match on the first page so an idle
 * channel costs zero quota (304). Otherwise walks order=time (newest first), collecting comments
 * newer than the cursor, and stops as soon as it reaches a known one — so steady-state polling reads
 * a single page. On a first poll (no cursor) it fetches exactly one page to avoid a backlog blowout.
 */
export async function pollCommentThreads(opts: PollOptions): Promise<PollResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxResults = opts.maxResults ?? 100;
  const maxPages = opts.sincePublishedAt ? (opts.maxPages ?? 5) : 1;
  const since = opts.sincePublishedAt ? Date.parse(opts.sincePublishedAt) : null;

  const collected: YtComment[] = [];
  let pageToken: string | undefined;
  let firstEtag: string | undefined;
  let quotaSpent = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      part: "snippet",
      allThreadsRelatedToChannelId: opts.channelId,
      order: "time",
      maxResults: String(maxResults),
      textFormat: "plainText",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const headers: Record<string, string> = { Authorization: `Bearer ${opts.accessToken}` };
    // Conditional request only on the first page (the newest slice — what an idle poll checks).
    if (page === 0 && opts.etag) headers["If-None-Match"] = opts.etag;

    const res = await fetchImpl(`${YT_API}/commentThreads?${params}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (page === 0 && res.status === 304) {
      return { notModified: true, etag: opts.etag ?? undefined, comments: [], quotaSpent: 0 };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new YouTubeApiError(res.status, `commentThreads.list ${res.status}: ${body.slice(0, 300)}`);
    }
    quotaSpent += 1;
    const data = (await res.json()) as ThreadListResponse;
    if (page === 0) firstEtag = data.etag;

    let reachedCursor = false;
    for (const raw of data.items ?? []) {
      const c = mapThread(raw);
      if (!c) continue;
      if (since !== null && Date.parse(c.publishedAt) <= since) {
        reachedCursor = true;
        break; // order=time → everything after this is older / already seen
      }
      collected.push(c);
    }
    if (reachedCursor || !data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return { notModified: false, etag: firstEtag, comments: collected, quotaSpent };
}

/** Reply to a comment (comments.insert, ~50 quota units). Returns the new comment id. */
export async function insertCommentReply(opts: {
  parentId: string;
  text: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${YT_API}/comments?part=snippet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ snippet: { parentId: opts.parentId, textOriginal: opts.text } }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YouTubeApiError(res.status, `comments.insert ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: data.id ?? null };
}

/**
 * Post a NEW top-level comment on a video (commentThreads.insert, ~50 quota units). Distinct from
 * {@link insertCommentReply} (comments.insert), which replies UNDER an existing comment — this is the
 * "first comment on a freshly-published video" path. Returns the new top-level comment id.
 */
export async function insertCommentThread(opts: {
  videoId: string;
  text: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string | null }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${YT_API}/commentThreads?part=snippet`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { videoId: opts.videoId, topLevelComment: { snippet: { textOriginal: opts.text } } },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YouTubeApiError(res.status, `commentThreads.insert ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: data.id ?? null };
}

/** Exchange a refresh token for a fresh access token (Google access tokens expire in ~1h). */
export async function refreshGoogleAccessToken(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YouTubeApiError(res.status, `Google token refresh ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new YouTubeApiError(500, "Google token refresh returned no access_token");
  return { accessToken: data.access_token, expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600) };
}

/** Resolve the authenticated user's own channel (channels.list mine=true) — for connect. */
export async function getMyChannel(opts: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; title: string; thumbnail: string | null; handle: string | null } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${YT_API}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new YouTubeApiError(res.status, `channels.list ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { items?: Array<{ id: string; snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } } }> };
  const ch = data.items?.[0];
  if (!ch) return null;
  // customUrl is the @handle (e.g. "@techskills") — used to sweep a pre-migration handle-keyed orphan.
  return { id: ch.id, title: ch.snippet?.title ?? ch.id, thumbnail: ch.snippet?.thumbnails?.default?.url ?? null, handle: ch.snippet?.customUrl ?? null };
}
