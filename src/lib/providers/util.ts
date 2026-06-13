/**
 * Narrow an untrusted provider-response field to a non-empty string (PSA51). A hostile or malformed
 * platform response can return `{"id":{…}}` — a truthy **object** that a `!field` guard would pass; it
 * would then coerce to "[object Object]" in a URL or violate the `string` contract of a typed column
 * (`provider_handle` / `provider_account_id`). Returns undefined for anything that isn't a real string.
 */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
