/**
 * Meta Graph API changelog scan (VPROBE2) — a review aid for version bumps, never a gate.
 *
 * Splits Meta's changelog page into leaf sections (h2 product › h3 topic › h4 change) and keeps the
 * ones that mention an API surface PostStack calls, so the reviewer reads a short list instead of the
 * whole page. Changelog prose is not a stable format; a miss here must not be read as "no change".
 */

export interface ChangelogSection {
  group: string;
  topic: string;
  title: string;
  text: string;
}

/** Surfaces PostStack calls (case-sensitive whole words: "Page" the product, not "this page"). */
const SURFACE_KEYWORDS = [
  "Page", "Pages", "Instagram", "Messenger", "messages", "conversations", "comments", "feed",
  "webhook", "webhooks", "subscribed_apps", "debug_token", "access token", "video_reels",
  "media_publish", "Graph API protocol",
];

/** Products PostStack never calls; their sections are dropped even when a keyword matches. */
const IGNORED_GROUPS = ["Marketing API"];

/** Version-lifecycle groups are always relevant: they carry the current version's sunset date. */
const ALWAYS_KEPT_GROUPS = ["API Version Deprecations"];

export function changelogUrl(version: string): string {
  return `https://developers.facebook.com/docs/graph-api/changelog/version${version.replace(/^v/, "")}/`;
}

function toText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leaf sections in page order; headings without their own body text (pure containers) are omitted. */
export function parseChangelogSections(rawHtml: string): ChangelogSection[] {
  const html = rawHtml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const headings = [...html.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/g)];
  const sections: ChangelogSection[] = [];
  let group = "";
  let topic = "";
  headings.forEach((m, i) => {
    const level = Number(m[1]);
    const title = toText(m[2]);
    if (level === 2) [group, topic] = [title, ""];
    if (level === 3) topic = title;
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].index : html.length;
    const text = toText(html.slice(m.index + m[0].length, bodyEnd));
    if (level >= 2 && text) sections.push({ group, topic, title, text });
  });
  return sections;
}

function mentionsSurface(section: ChangelogSection): boolean {
  const haystack = `${section.topic} ${section.title} ${section.text}`;
  return SURFACE_KEYWORDS.some((k) => new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`).test(haystack));
}

export function relevantChangelogSections(sections: ChangelogSection[]): ChangelogSection[] {
  return sections.filter((s) =>
    ALWAYS_KEPT_GROUPS.includes(s.group) || (!IGNORED_GROUPS.includes(s.group) && mentionsSurface(s)));
}

const EXCERPT_CHARS = 600;

export function changelogDigest(version: string, sections: ChangelogSection[]): string {
  const source = changelogUrl(version);
  if (sections.length === 0) {
    return `Changelog scan for ${version}: no sections mention a surface PostStack calls — still skim ${source}.`;
  }
  const items = sections.map((s) => {
    const label = [s.group, s.topic].filter(Boolean).join(" › ");
    const heading = s.title === label || !label ? s.title : `${label} — ${s.title}`;
    const excerpt = s.text.length > EXCERPT_CHARS ? `${s.text.slice(0, EXCERPT_CHARS)}…` : s.text;
    return `- **${heading}**\n  ${excerpt}`;
  });
  return [
    `### Changelog sections to review for ${version}`,
    `Source: ${source} (keyword scan — a review aid, not proof of compatibility).`,
    "",
    ...items,
  ].join("\n");
}
