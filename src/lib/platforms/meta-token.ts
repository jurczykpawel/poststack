import { env } from "@/lib/env";
import { GRAPH_API_BASE } from "./constants";

/**
 * How a pasted Meta token connects channels:
 *  - "page"        → a single Page's token. Connects exactly that one Page (the FREE path). No
 *                    expires_at of its own, but inherits the ~90-day data-access wall of the user it
 *                    was minted from.
 *  - "user"        → a (long-lived) user token. Enumerates ALL Pages + linked IG. expires_at ~60d,
 *                    90-day data-access wall (reset only by re-login). The OAuth master.
 *  - "system_user" → a Business-Manager System User token. Enumerates everything, and is truly
 *                    permanent (no expires_at, no data-access wall). The recommended PRO master.
 */
export type MetaTokenKind = "page" | "user" | "system_user";

export interface MetaTokenInfo {
  kind: MetaTokenKind;
  appId?: string;
  isValid: boolean;
  /** Unix seconds; undefined → the token itself never expires (page / System User). */
  expiresAt?: number;
  /** Unix seconds; undefined → no 90-day data-access wall (System User). */
  dataAccessExpiresAt?: number;
  scopes: string[];
  /** For a PAGE token, the Page id it is scoped to. */
  profileId?: string;
}

/**
 * A connect failure with a SPECIFIC, user-facing reason (foreign app / invalid / expired / missing
 * scope) instead of a generic "validation failed". Routes surface `.message` directly.
 */
export class MetaTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaTokenError";
  }
}

interface DebugTokenData {
  app_id?: string;
  type?: string;
  is_valid?: boolean;
  expires_at?: number;
  data_access_expires_at?: number;
  scopes?: string[];
  profile_id?: string;
}

/** Meta uses 0 to mean "never expires"; normalize that (and any falsy) to undefined. */
function normalizeExpiry(v?: number): number | undefined {
  return typeof v === "number" && v > 0 ? v : undefined;
}

/**
 * Classify the token. Graph reports `type: "PAGE"` for page tokens and `type: "USER"` for both human
 * and System User tokens, so a System User token is detected as a USER token with NO death clock AND
 * NO data-access wall (the only truly-permanent shape).
 */
function classifyKind(data: DebugTokenData): MetaTokenKind {
  if (String(data.type ?? "").toUpperCase() === "PAGE") return "page";
  if (!normalizeExpiry(data.expires_at) && !normalizeExpiry(data.data_access_expires_at)) {
    return "system_user";
  }
  return "user";
}

/**
 * Inspect a pasted Meta token via `GET /debug_token`: its type, validity, both expiry clocks, granted
 * scopes, and (for a page token) the page id. Throws {@link MetaTokenError} with a specific reason for
 * a CONFIRMED foreign-app / invalid / expired token.
 *
 * Returns `null` (validation skipped) when:
 *  - the app credentials aren't configured (can't call debug_token), or
 *  - the debug_token call itself doesn't succeed (a Meta-side hiccup must not block a connect that
 *    would otherwise work — we only reject on a confirmed bad token).
 */
export async function inspectMetaToken(token: string): Promise<MetaTokenInfo | null> {
  if (!env.META_APP_ID || !env.META_APP_SECRET) return null;

  let res: Response;
  try {
    res = await fetch(
      `${GRAPH_API_BASE}/debug_token?` +
        new URLSearchParams({
          input_token: token,
          access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return null; // network/timeout — don't block connect on a transient debug_token failure
  }
  if (!res.ok) return null;

  const data = ((await res.json().catch(() => ({}))) as { data?: DebugTokenData }).data;
  if (!data) return null;

  if (data.is_valid === false) {
    throw new MetaTokenError("This access token is invalid or expired. Generate a fresh token and try again.");
  }
  if (data.app_id && String(data.app_id) !== String(env.META_APP_ID)) {
    throw new MetaTokenError("This access token belongs to a different Facebook app. Generate a token for THIS app.");
  }

  return {
    kind: classifyKind(data),
    appId: data.app_id ? String(data.app_id) : undefined,
    isValid: data.is_valid ?? true, // narrowed: the is_valid === false case already threw above
    expiresAt: normalizeExpiry(data.expires_at),
    dataAccessExpiresAt: normalizeExpiry(data.data_access_expires_at),
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    profileId: data.profile_id ? String(data.profile_id) : undefined,
  };
}

/**
 * Assert a pasted token belongs to THIS app and is currently valid. Thin wrapper over
 * {@link inspectMetaToken} kept for callers that only need the guard (it throws the same specific
 * {@link MetaTokenError}s; a null inspection — creds missing / transient failure — is a no-op).
 */
export async function assertMetaTokenBelongsToApp(token: string): Promise<void> {
  await inspectMetaToken(token);
}

/**
 * Throw a specific {@link MetaTokenError} if the token is missing any scope required to operate the
 * platform, so a connect fails fast with "grant X" instead of dead-lettering every send later. A null
 * inspection (creds missing / transient) skips the check.
 */
export function assertMetaScopes(
  info: MetaTokenInfo | null,
  required: readonly string[],
  platformLabel: string,
): void {
  if (!info || info.scopes.length === 0) return; // unknown scope set — don't block on missing data
  const missing = required.filter((s) => !info.scopes.includes(s));
  if (missing.length > 0) {
    throw new MetaTokenError(
      `This token is missing permissions required for ${platformLabel}: ${missing.join(", ")}. ` +
        `Regenerate it with those scopes granted.`,
    );
  }
}
