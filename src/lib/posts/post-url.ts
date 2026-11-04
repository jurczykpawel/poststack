/** A URL safe for href: only http(s), anything else (javascript:, data:, bare ids) becomes null. */
export const httpUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

/** Public URL of a post built from its platform id alone, for rows that stored no permalink.
 *  Instagram media ids carry no shortcode, so IG gets no fallback; TikTok needs the account handle.
 *  `context` is the delivery the id came from: a bare Facebook reel id (stored before FBREEL1) is a
 *  post id, not a video id, and only opens through its Page (recorded 2026-11-04). */
export function postUrlFor(platform: string, postId: string | null | undefined, handle?: string | null, context?: { format?: string; pageId?: string }): string | null {
  if (!postId || /^https?:\/\//i.test(postId)) return null;
  const id = encodeURIComponent(postId);
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (platform === "facebook") {
    // Graph ids: `<pageId>_<postId>` (feed/photo/reel posts) or a bare numeric video id; a bare id is not a profile URL.
    const m = /^(\d+)_(\d+)$/.exec(postId);
    if (m) return `https://www.facebook.com/${m[1]}/posts/${m[2]}`;
    if (context?.format === "reel" && context.pageId && /^\d+$/.test(postId)) return `https://www.facebook.com/${encodeURIComponent(context.pageId)}/posts/${id}`;
    return /^\d+$/.test(postId) ? `https://www.facebook.com/watch/?v=${id}` : `https://www.facebook.com/${id}`;
  }
  if (platform === "tiktok" && handle && /^\d+$/.test(postId)) return `https://www.tiktok.com/@${encodeURIComponent(handle.replace(/^@/, ""))}/video/${id}`;
  return null;
}

