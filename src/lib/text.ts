/**
 * Truncate to at most `max` Unicode code points (not UTF-16 code units), so an astral character
 * such as an emoji at the boundary is never split into a lone surrogate. A split surrogate becomes
 * U+FFFD mojibake once stored in Postgres (utf8). Used for message/post previews.
 */
export function truncateCodePoints(text: string, max: number): string {
  const cp = [...text];
  return cp.length > max ? cp.slice(0, max).join("") : text;
}
