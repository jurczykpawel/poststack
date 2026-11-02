/** MQA13-B01: a brand key appears in URLs and markup, so it is a slug (letters, digits, `.`, `_`, `-`;
 *  no leading dot). MQA13-B05: the accent is written into a style attribute, so it is a hex colour. */
export const BRAND_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const BRAND_ACCENT_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
