/**
 * Sanitize a string for safe logging (prevent log injection).
 * Strips newlines, carriage returns, and control characters.
 */
export function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\x00-\x1f\x7f]/g, "");
}
