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
