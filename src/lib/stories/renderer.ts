// STORY1 / STORYCFG1: server-side composition of a 9:16 "Story about a post" card → 1080×1920 JPEG.
// The platforms have no API-native "share post to story" with interactive overlays, so we publish a
// flat image. Composition is split into a TEMPLATE REGISTRY: each template is a pure `plan()` that
// returns background + overlay SVG (+ where to composite the post/reel cover). `SharpStoryRenderer`
// rasterises the plan. This is the extensibility seam: built-in templates ship now; a PRO tier can
// later register custom templates / pass custom `StoryStyle` (accent, fonts, CTA, own template) WITHOUT
// touching the publish flow — `registerStoryTemplate` + the `StoryStyle` object are that boundary.

/** IG/FB story canvas — portrait 9:16. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

/** The content of the card (what to say + the cover image). Presentation lives in {@link StoryStyle}. */
export interface StoryCard {
  /** Teaser/intro text drawn on the card (the post caption/title). */
  caption: string;
  /** Small label drawn as the brand mark (channel/brand name) when `style.brandName` is unset. */
  accountName?: string;
  /** Optional image bytes (the post's media / reel cover) composited as the card's visual. Non-image /
   *  unreadable bytes are ignored — the card still renders as a text-only gradient. */
  thumbnail?: Uint8Array;
}

/** Presentation knobs. Built-ins read these; a future PRO tier supplies custom values / a custom
 *  template id. All optional → sensible defaults so the free path never needs to set anything. */
export interface StoryStyle {
  /** Built-in template id (see STORY_TEMPLATES). Unknown / unset → DEFAULT_STORY_TEMPLATE. */
  template?: string;
  /** Brand accent hex (arrow, kicker bar, brand mark). Defaults to a neutral blue. */
  accent?: string;
  /** Brand display name for the footer mark. Falls back to card.accountName. */
  brandName?: string;
  /** Call-to-action label on the cover pill. Defaults to "Watch full reel". */
  ctaLabel?: string;
}

interface ResolvedStyle {
  accent: string;
  brandName: string;
  ctaLabel: string;
}

/** Where to composite the (rounded) cover image. Absent → text-only / no cover. */
export interface CoverRect { x: number; y: number; w: number; h: number; radius: number; }

/** A template's pure layout output. `bgSvg` is drawn first (full canvas), the cover image next (if any),
 *  `overlaySvg` last (arrow / play badge / CTA pill / brand mark / text over the cover). */
export interface StoryPlan {
  bg: { r: number; g: number; b: number };
  bgSvg: string;
  cover?: CoverRect;
  overlaySvg: string;
}

export interface StoryTemplate {
  id: string;
  plan(card: StoryCard, style: ResolvedStyle, hasThumbnail: boolean): StoryPlan;
}

export const DEFAULT_STORY_TEMPLATE = "framed";
const DEFAULT_ACCENT = "#2f6df6";

// ── text helpers ──────────────────────────────────────────────────────────────────────────────
const XML_ESCAPES: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" };
function escapeXml(s: string): string { return s.replace(/[<>&'"]/g, (c) => XML_ESCAPES[c] ?? c); }

// libvips has no colour-emoji font → emoji render as black tofu. Strip emoji + variation selectors /
// ZWJ from rendered text so a caption with 👇🔥 doesn't blot the card. (Plain text is unaffected.)
// Intentionally also strips emoji modifiers (variation selectors FE0x, ZWJ 200D, keycap 20E3) so a
// sequence like 1️⃣ / 👨‍💻 leaves no tofu — hence the disabled char-class rule.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu;
function stripEmoji(s: string): string { return s.replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim(); }

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
      if (lines.length === maxLines - 1) { truncated = true; break; }
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  else if (cur) truncated = true;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = `${last.replace(/[.,!?…]*$/, "").slice(0, maxChars - 1)}…`;
  }
  return lines;
}
function tspans(lines: string[], x: number, leading: number): string {
  return lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : leading}">${escapeXml(l)}</tspan>`).join("");
}

// ── shared vector pieces ────────────────────────────────────────────────────────────────────────
interface Pt { x: number; y: number; }
/** Precise arrow: a single smooth cubic-bezier shaft stopping at the head base, plus a clean filled
 *  triangular head oriented along the curve's exit tangent. */
function arrow(p0: Pt, c0: Pt, c1: Pt, tip: Pt, color: string, width = 22, headLen = 52, headHalf = 34): string {
  const ang = Math.atan2(tip.y - c1.y, tip.x - c1.x);
  const base = { x: tip.x - headLen * Math.cos(ang), y: tip.y - headLen * Math.sin(ang) };
  const left = { x: base.x - headHalf * Math.sin(ang), y: base.y + headHalf * Math.cos(ang) };
  const right = { x: base.x + headHalf * Math.sin(ang), y: base.y - headHalf * Math.cos(ang) };
  return `<path d="M ${p0.x} ${p0.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${base.x} ${base.y}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round"/>
    <path d="M ${tip.x} ${tip.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z" fill="${color}"/>`;
}
const reelPill = (cx: number, y: number, label: string) =>
  `<rect x="${cx - 195}" y="${y}" width="390" height="68" rx="34" fill="rgba(0,0,0,0.62)"/><text x="${cx}" y="${y + 45}" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="#fff">▶ ${escapeXml(label)}</text>`;
const brandMark = (x: number, y: number, color: string, accent: string, name: string) =>
  name ? `<rect x="${x}" y="${y - 26}" width="30" height="30" rx="7" fill="${accent}"/><text x="${x + 44}" y="${y}" font-family="Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="${color}">${escapeXml(name.slice(0, 40))}</text>` : "";

// ── built-in templates ──────────────────────────────────────────────────────────────────────────
/** classic — the original look: cover fills the top, caption on a bottom scrim. Back-compat default
 *  for any caller that doesn't ask for a template. */
const classic: StoryTemplate = {
  id: "classic",
  plan(card, style, hasThumbnail) {
    const lines = wrapLines(stripEmoji(card.caption ?? ""), 26, 5);
    const top = STORY_HEIGHT - 260 - lines.length * 74;
    const accountY = top - 70;
    const caption = lines.length ? `<text x="80" y="${top}" font-family="Helvetica,Arial,sans-serif" font-size="58" font-weight="800" fill="#ffffff">${tspans(lines, 80, 74)}</text>` : "";
    const account = style.brandName ? `<text x="80" y="${accountY}" font-family="Helvetica,Arial,sans-serif" font-size="34" font-weight="700" letter-spacing="2" fill="${style.accent}">${escapeXml(style.brandName.slice(0, 40).toUpperCase())}</text>` : "";
    const bgSvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#181f3a"/><stop offset="1" stop-color="#0b1020"/></linearGradient>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#0b1020" stop-opacity="0"/><stop offset="1" stop-color="#0b1020" stop-opacity="0.96"/></linearGradient></defs>
      ${hasThumbnail ? "" : `<rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#bg)"/><circle cx="880" cy="320" r="340" fill="#3a2a78" opacity="0.55"/><circle cx="180" cy="780" r="240" fill="#1b2c6b" opacity="0.5"/>`}</svg>`;
    const overlaySvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#0b1020" stop-opacity="0"/><stop offset="1" stop-color="#0b1020" stop-opacity="0.96"/></linearGradient></defs>
      <rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#scrim)"/>
      <rect x="80" y="${accountY - 36}" width="56" height="6" rx="3" fill="${style.accent}"/>${account}${caption}</svg>`;
    return { bg: { r: 11, g: 16, b: 32 }, bgSvg, cover: hasThumbnail ? { x: 0, y: 0, w: STORY_WIDTH, h: 1320, radius: 0 } : undefined, overlaySvg };
  },
};

/** framed — light editorial: teaser (serif) on top, a precise arrow pointing to the framed cover with
 *  a CTA pill, brand mark in the corner. */
const framed: StoryTemplate = {
  id: "framed",
  plan(card, style) {
    const lines = wrapLines(stripEmoji(card.caption ?? ""), 28, 5);
    const cw = 540, ch = 960, cx = 470, cy = 720;
    const bgSvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef1f6"/></linearGradient></defs>
      <rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#bg)"/>
      <rect x="80" y="160" width="64" height="8" rx="4" fill="${style.accent}"/>
      <text x="80" y="252" font-family="Georgia,serif" font-size="52" font-weight="700" fill="#15171c">${tspans(lines, 80, 72)}</text></svg>`;
    const overlaySvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      ${arrow({ x: 250, y: 660 }, { x: 200, y: 850 }, { x: 250, y: 980 }, { x: cx - 18, y: 1000 }, style.accent)}
      ${reelPill(cx + cw / 2, cy + ch - 108, style.ctaLabel)}
      ${brandMark(80, STORY_HEIGHT - 70, "#15171c", style.accent, style.brandName)}</svg>`;
    return { bg: { r: 255, g: 255, b: 255 }, bgSvg, cover: { x: cx, y: cy, w: cw, h: ch, radius: 30 }, overlaySvg };
  },
};

/** phone — dark: teaser on top, the cover inside a device mock, a precise arrow pointing to it. */
const phone: StoryTemplate = {
  id: "phone",
  plan(card, style) {
    const lines = wrapLines(stripEmoji(card.caption ?? ""), 26, 5);
    const fw = 520, fh = 924, fx = 490, fy = 740, pad = 18;
    const bgSvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2138"/><stop offset="1" stop-color="#0b1020"/></linearGradient></defs>
      <rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#bg)"/>
      <rect x="80" y="180" width="64" height="8" rx="4" fill="${style.accent}"/>
      <text x="80" y="272" font-family="Helvetica,Arial,sans-serif" font-size="54" font-weight="800" fill="#fff">${tspans(lines, 80, 72)}</text>
      <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" rx="48" fill="#000" stroke="#2a3252" stroke-width="3"/>
      <rect x="${fx + fw / 2 - 58}" y="${fy + 16}" width="116" height="20" rx="10" fill="#0b1020"/></svg>`;
    const overlaySvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      ${arrow({ x: 270, y: 800 }, { x: 220, y: 1000 }, { x: 280, y: 1130 }, { x: fx + pad - 18, y: 1150 }, style.accent)}
      ${reelPill(fx + fw / 2, fy + fh - 116, style.ctaLabel)}
      ${brandMark(80, STORY_HEIGHT - 80, "#fff", style.accent, style.brandName)}</svg>`;
    return { bg: { r: 11, g: 16, b: 32 }, bgSvg, cover: { x: fx + pad, y: fy + pad, w: fw - pad * 2, h: fh - pad * 2, radius: 24 }, overlaySvg };
  },
};

/** fullbleed — the reel cover fills the whole canvas; a top scrim carries the teaser, a bottom scrim
 *  the CTA pill + brand mark. No arrow (the cover IS the background). Text ellipsizes to stay readable. */
const fullbleed: StoryTemplate = {
  id: "fullbleed",
  plan(card, style, hasThumbnail) {
    const lines = wrapLines(stripEmoji(card.caption ?? ""), 27, 4);
    const bgSvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#181f3a"/><stop offset="1" stop-color="#0b1020"/></linearGradient></defs>
      ${hasThumbnail ? "" : `<rect width="${STORY_WIDTH}" height="${STORY_HEIGHT}" fill="url(#bg)"/>`}</svg>`;
    const overlaySvg = `<svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs>
      <linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.78"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
      <linearGradient id="bot" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient></defs>
      <rect width="${STORY_WIDTH}" height="640" fill="url(#top)"/>
      <rect y="${STORY_HEIGHT - 520}" width="${STORY_WIDTH}" height="520" fill="url(#bot)"/>
      <rect x="80" y="160" width="64" height="8" rx="4" fill="${style.accent}"/>
      <text x="80" y="252" font-family="Helvetica,Arial,sans-serif" font-size="52" font-weight="800" fill="#fff">${tspans(lines, 80, 68)}</text>
      ${reelPill(STORY_WIDTH / 2, STORY_HEIGHT - 240, style.ctaLabel)}
      ${brandMark(80, STORY_HEIGHT - 100, "#fff", style.accent, style.brandName)}</svg>`;
    return { bg: { r: 11, g: 16, b: 32 }, bgSvg, cover: hasThumbnail ? { x: 0, y: 0, w: STORY_WIDTH, h: STORY_HEIGHT, radius: 0 } : undefined, overlaySvg };
  },
};

/** Built-in template registry. PRO custom templates register into this map (see registerStoryTemplate). */
export const STORY_TEMPLATES: Record<string, StoryTemplate> = { classic, framed, phone, fullbleed };

/** Extensibility seam (reserved for a PRO "custom story templates" feature): register a template by id.
 *  Not wired to any UI yet — the boundary exists so custom templates plug in without renderer changes. */
export function registerStoryTemplate(t: StoryTemplate): void { STORY_TEMPLATES[t.id] = t; }

export function resolveStoryTemplate(id?: string): StoryTemplate {
  return (id && STORY_TEMPLATES[id]) || STORY_TEMPLATES[DEFAULT_STORY_TEMPLATE]!;
}
function resolveStyle(card: StoryCard, style?: StoryStyle): ResolvedStyle {
  return {
    accent: style?.accent?.trim() || DEFAULT_ACCENT,
    brandName: (style?.brandName ?? card.accountName ?? "").trim(),
    ctaLabel: style?.ctaLabel?.trim() || "Watch full reel",
  };
}

export interface StoryRenderer {
  /** Compose the card and return JPEG bytes (1080×1920). */
  render(card: StoryCard, style?: StoryStyle): Promise<Uint8Array>;
}

/** Default renderer backed by `sharp` (libvips). `sharp` is imported lazily so merely importing this
 *  module (e.g. in the web process or a test that injects a fake) never loads the native binding. */
export class SharpStoryRenderer implements StoryRenderer {
  async render(card: StoryCard, style?: StoryStyle): Promise<Uint8Array> {
    const sharp = (await import("sharp")).default;
    const hasThumbnail = !!card.thumbnail && card.thumbnail.byteLength > 0;
    const plan = resolveStoryTemplate(style?.template).plan(card, resolveStyle(card, style), hasThumbnail);

    const layers: { input: Buffer; top: number; left: number }[] = [
      { input: await sharp(Buffer.from(plan.bgSvg)).png().toBuffer(), top: 0, left: 0 },
    ];

    if (plan.cover && card.thumbnail && card.thumbnail.byteLength > 0) {
      try {
        const { x, y, w, h, radius } = plan.cover;
        const resized = await sharp(Buffer.from(card.thumbnail)).resize(w, h, { fit: "cover", position: "attention" }).toBuffer();
        const cover = radius > 0
          ? await sharp(resized).composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`), blend: "dest-in" }]).png().toBuffer()
          : resized;
        layers.push({ input: cover, top: y, left: x });
      } catch {
        // Unreadable / non-raster bytes (e.g. a video URL) → skip the cover; the bg/overlay still render.
      }
    }

    layers.push({ input: await sharp(Buffer.from(plan.overlaySvg)).png().toBuffer(), top: 0, left: 0 });

    const out = await sharp({ create: { width: STORY_WIDTH, height: STORY_HEIGHT, channels: 3, background: plan.bg } })
      .composite(layers)
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    return new Uint8Array(out);
  }
}
