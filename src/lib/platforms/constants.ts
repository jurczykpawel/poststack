/**
 * Meta Graph API version — single source of truth.
 *
 * When bumping, update this value and run the full test suite
 * to verify nothing breaks on the new API version.
 *
 * Changelog: https://developers.facebook.com/docs/graph-api/changelog
 */
export const META_API_VERSION = "v25.0";

export const GRAPH_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;
export const META_OAUTH_BASE = `https://www.facebook.com/${META_API_VERSION}`;

/**
 * Instagram Graph API version — separate from META_API_VERSION because Instagram Business Login
 * talks to `graph.instagram.com` (a different host than `graph.facebook.com`) and is versioned
 * independently. Kept aligned with FB by default; bumping IG = this one place only.
 *
 * Changelog: https://developers.facebook.com/docs/instagram-platform/changelog
 */
export const IG_GRAPH_API_VERSION = "v25.0";
export const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_GRAPH_API_VERSION}`;
export const IG_OAUTH_BASE = "https://www.instagram.com"; // /oauth/authorize
export const IG_OAUTH_TOKEN_BASE = "https://api.instagram.com"; // /oauth/access_token (short-lived)
