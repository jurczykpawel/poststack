// PSA13 — strip secrets from any string before it is persisted (last_error / needs_reauth_reason),
// emitted to a user-registered webhook, or logged. Provider error text / undici error URLs can echo
// back a token (e.g. Graph calls carry access_token in the query); this is the single egress chokepoint.
const PATTERNS: [RegExp, string][] = [
  // query-string / form: access_token=…  client_secret=…  refresh_token=…
  [/(?<![\w])((?:access_token|client_secret|refresh_token)=)[^&\s"'#]+/gi, "$1[REDACTED]"],
  // JSON: "access_token":"…"
  [/("(?:access_token|client_secret|refresh_token)"\s*:\s*")[^"]+/gi, "$1[REDACTED]"],
  // Authorization: Bearer <token>
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[REDACTED]"],
];

/** Replace known token/secret patterns in `s` with `[REDACTED]`. Safe to call on any error string. */
export function redactSecrets(s: string): string {
  return PATTERNS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);
}
