/** Public URL of a post built from its platform id alone, for rows that stored no permalink.
 *  Instagram media ids carry no shortcode, so IG gets no fallback; TikTok needs the account handle. */
export function postUrlFor(platform: string, postId: string | null | undefined, handle?: string | null): string | null {
  if (!postId || /^https?:\/\//i.test(postId)) return null;
  const id = encodeURIComponent(postId);
  if (platform === "youtube") return `https://www.youtube.com/watch?v=${id}`;
  if (platform === "facebook") return `https://www.facebook.com/${id}`;
  if (platform === "tiktok" && handle && /^\d+$/.test(postId)) return `https://www.tiktok.com/@${encodeURIComponent(handle.replace(/^@/, ""))}/video/${id}`;
  return null;
}

