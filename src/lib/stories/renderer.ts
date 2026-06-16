// STORY1: server-side composition of a 9:16 "Story about a post" card. Phase 1 = a generated card
// (gradient background + caption text + optional post thumbnail) rendered to a 1080×1920 JPEG. The
// platforms have no API-native "share post to story" with interactive overlays, so we publish a flat
// image. Kept behind the `StoryRenderer` interface so phase 2 (templates / ReelStack composition) can
// swap the implementation without touching the publish flow.

/** IG/FB story canvas — portrait 9:16. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

export interface StoryCard {
  /** Headline text drawn on the card (the post caption/title). */
  caption: string;
  /** Small label drawn above the caption (e.g. the channel/brand name). */
  accountName?: string;
  /** Optional image bytes (the post's media) composited as the card's visual. Non-image / unreadable
   *  bytes are ignored — the card still renders as a text-only gradient. */
  thumbnail?: Uint8Array;
}

export interface StoryRenderer {
  /** Compose the card and return JPEG bytes (1080×1920). */
  render(card: StoryCard): Promise<Uint8Array>;
}

const XML_ESCAPES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "'": "&apos;",
  '"': "&quot;",
};
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c] ?? c);
}

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars`, ellipsizing an overflow. */
function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = "";
  let truncated = false;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      if (lines.length === maxLines - 1) {
        truncated = true;
        break;
      }
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  else if (cur) truncated = true;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = `${last.replace(/[.,!?…]*$/, "").slice(0, maxChars - 1)}…`;
  }
  return lines;
}

const CAPTION_MAX_CHARS = 26;
const CAPTION_MAX_LINES = 5;
const CAPTION_FONT = 58;
const CAPTION_LEADING = 74;

/** Build the overlay SVG (decorative gradient + scrim + text). */
function overlaySvg(card: StoryCard, hasThumbnail: boolean): string {
  const lines = wrapLines(card.caption ?? "", CAPTION_MAX_CHARS, CAPTION_MAX_LINES);
  const blockHeight = lines.length * CAPTION_LEADING;
  // Anchor the text block toward the lower third; with a thumbnail it sits on the bottom scrim.
  const captionTop = STORY_HEIGHT - 260 - blockHeight;
  const accountY = captionTop - 70;

  const tspans = lines
    .map((line, i) => `<tspan x="80" dy="${i === 0 ? 0 : CAPTION_LEADING}">${escapeXml(line)}</tspan>`)
    .join("");

  const account = card.accountName?.trim()
    ? `<text x="80" y="${accountY}" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="2" fill="#8b9bff">${escapeXml(
        card.accountName.trim().slice(0, 40).toUpperCase(),
      )}</text>`
    : "";

  const caption =
    lines.length > 0
      ? `<text x="80" y="${captionTop}" font-family="Helvetica, Arial, sans-serif" font-size="${CAPTION_FONT}" font-weight="800" fill="#ffffff">${tspans}</text>`
      : "";

  // With a thumbnail: a bottom scrim only (the image owns the top). Without: a full decorative
  // indigo gradient so the text-only card still looks designed.
  const background = hasThumbnail
    ? `<rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#scrim)"/>`
    : `<rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#bg)"/>
       <circle cx="880" cy="320" r="340" fill="#3a2a78" opacity="0.55"/>
       <circle cx="180" cy="780" r="240" fill="#1b2c6b" opacity="0.5"/>
       <rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#scrim)"/>`;

  return `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#181f3a"/>
      <stop offset="1" stop-color="#0b1020"/>
    </linearGradient>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.4" stop-color="#0b1020" stop-opacity="0"/>
      <stop offset="1" stop-color="#0b1020" stop-opacity="0.96"/>
    </linearGradient>
  </defs>
  ${background}
  <rect x="80" y="${accountY - 36}" width="56" height="6" rx="3" fill="#8b9bff"/>
  ${account}
  ${caption}
</svg>`;
}

/** Default renderer backed by `sharp` (libvips). `sharp` is imported lazily so merely importing this
 *  module (e.g. in the web process or a test that injects a fake) never loads the native binding. */
export class SharpStoryRenderer implements StoryRenderer {
  async render(card: StoryCard): Promise<Uint8Array> {
    const sharp = (await import("sharp")).default;

    const layers: { input: Buffer; top: number; left: number }[] = [];

    // The post media, when it's a usable image: cover the top portion of the canvas.
    if (card.thumbnail && card.thumbnail.byteLength > 0) {
      try {
        const thumb = await sharp(Buffer.from(card.thumbnail))
          .resize(STORY_WIDTH, 1320, { fit: "cover", position: "attention" })
          .toBuffer();
        layers.push({ input: thumb, top: 0, left: 0 });
      } catch {
        // Unreadable / non-raster bytes (e.g. a video URL) → fall back to the text-only card.
      }
    }

    const overlay = await sharp(Buffer.from(overlaySvg(card, layers.length > 0)))
      .png()
      .toBuffer();
    layers.push({ input: overlay, top: 0, left: 0 });

    const out = await sharp({
      create: { width: STORY_WIDTH, height: STORY_HEIGHT, channels: 3, background: { r: 11, g: 16, b: 32 } },
    })
      .composite(layers)
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();

    return new Uint8Array(out);
  }
}
