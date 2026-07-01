/**
 * Sanitize a string for safe logging (prevent log injection).
 * Strips newlines, carriage returns, and control characters.
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}

/**
 * Defence-in-depth (stored-XSS): neutralize HTML metacharacters in attacker-reachable text stored in
 * a diagnostic log (e.g. webhook diagnostic fields, or an AI-generation log's user message — a public
 * comment/DM the model was asked to reply to) AT THE WRITE BOUNDARY, so the stored value is safe
 * regardless of how it is later rendered — even if a render site is ever switched from auto-escaping
 * `html`` to `raw()`. Maps `<`/`>`/`&` to their fullwidth look-alikes (rather than HTML-escaping) so
 * the text stays human-readable and avoids double-escape ugliness with Hono's auto-escaping `html``.
 */
export function neutralizeHtml(value: string): string {
  return value.replace(/</g, "＜").replace(/>/g, "＞").replace(/&/g, "＆");
}
