import { html } from "hono/html";
import type { PostCardData } from "@/lib/posts/preview";
import { localTime } from "./format";
import { icon } from "./icons";
import { PLATFORM_LABELS, platformGlyph } from "./platform";

/** One look for a published post wherever we point at it: Engagement, Queue, Content, Activity (POSTPREVIEW1). */
export function postPreview(c: PostCardData) {
  const platform = PLATFORM_LABELS[c.platform] ?? c.platform;
  return html`<article class="post-preview" data-post-preview>
    <div class="post-preview-media">${c.imageUrl
      ? html`<img src="${c.imageUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
      : icon(c.video ? "video" : "image", "ico", 22)}</div>
    <div class="post-preview-body">
      <p class="post-preview-meta">${platformGlyph(c.platform, 14)}<span>${c.channelName}</span></p>
      ${c.at ? html`<p class="post-preview-meta">${localTime(c.at)}</p>` : ""}
      <p class="post-preview-text">${c.text ?? html`<span class="muted">No text to show</span>`}</p>
      ${c.url ? html`<a class="post-preview-link" href="${c.url}" target="_blank" rel="noopener">View on ${platform} ↗</a>` : ""}
    </div>
  </article>`;
}
