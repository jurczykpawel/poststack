// The PUBLISH provider model (ported from PostStack). Distinct from the inbound SocialProvider in
// `@/lib/platforms`; Task 4/6 unify them so one provider per platform serves BOTH inbound + publish.
// This model owns its own token shape (TokenSet, camelCase) — the delivery engine converts the
// channel's stored token to it at the boundary.

/** Publish-side token shape. The engine decrypts the channel token into this before calling publish. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string; // ISO timestamp
  /**
   * IGFU1: the Instagram Business Login token (IGQW, from the channel's `messaging_token`). Present on
   * IG-Login-connected channels. When the channel has NO Facebook page token (`accessToken` empty),
   * the Meta provider routes publishing to graph.instagram.com with this token — single-login publish.
   */
  messagingToken?: string;
}

export type MediaIngestion = "pull_url" | "resumable_upload" | "chunked_upload";

export interface FormatCapability {
  format: string;
  media: { min: number; max: number; kinds: ("video" | "image")[] };
  video?: { maxDurationSec?: number; aspectRatios?: string[]; maxSizeMB?: number };
  image?: { maxSizeMB?: number; aspectRatios?: string[] };
  caption?: { maxLength: number; required: boolean };
  title?: { maxLength: number; required: boolean };
  requiredOptions?: string[];
  mediaIngestion: MediaIngestion;
}

export interface MediaRef {
  mediaId: string;
}

export interface PublishRequest {
  format: string;
  media: MediaRef[];
  caption?: string;
  title?: string;
  options?: Record<string, unknown>;
  /** FIRSTCOMMENT1: per-post override for the auto-posted first comment. Falls back to the channel's
   *  `default_first_comment` when omitted; empty/whitespace disables it for this post. */
  firstComment?: string;
  /** STORY1: per-post override for the auto-Story. `true`/`false` wins over the channel's
   *  `default_auto_story`; omitted = use the channel default. */
  autoStory?: boolean;
}

export interface AccountInfo {
  accountId: string;
  displayName?: string;
  avatarUrl?: string; // the account's profile image, when the provider exposes it (https)
  handle?: string; // human-readable @handle (e.g. YouTube customUrl, "@techskills"); stored in metadata
}

/** Introspection of a parent master token (e.g. Meta debug_token). */
export interface SourceInfo {
  providerAccountId: string; // master account id (e.g. FB user id)
  type?: string; // "user" | "system_user"
  dataAccessExpiresAt?: string; // ISO; undefined = no data-access wall (System User)
  scopes?: string[];
}

/** OAuth2 authorization-code config for a provider (admin connect flow). */
export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string; // resolved from env
  clientSecret: string;
  extraAuthParams?: Record<string, string>; // e.g. access_type=offline, prompt=consent
  clientIdParam?: string; // default "client_id" (TikTok uses "client_key")
  scopeSeparator?: string; // default " " (TikTok/Threads use ",")
  usePkce?: boolean; // X (Twitter) OAuth2 requires PKCE
  tokenAuthBasic?: boolean; // send client creds as a Basic auth header (X)
}

/** A sub-account enumerated from a master token, with its own minted token. */
export interface SubAccount {
  platform: string; // derived channel platform (e.g. "meta")
  providerAccountId: string; // page id OR ig user id
  displayName?: string;
  token: TokenSet; // minted token (e.g. a Meta page token)
  metadata?: Record<string, unknown>; // e.g. { subKind: "facebook_page" | "instagram" }
}

export interface PublishHandle {
  providerHandle: string;
}

export type PublishState = "accepted" | "published" | "failed";
export interface PublishStatus {
  state: PublishState;
  url?: string;
  error?: string;
}

export interface Provider {
  id: string;
  label: string;
  capabilities(): FormatCapability[];
  connectionModes(): ("oauth" | "manual_token")[];
  requiresTokenRefresh(): boolean;
  /** Liveness check. Returns account info when healthy; throws TokenInvalidError (dead)
   *  or TransientError (retry). */
  healthCheck(tokens: TokenSet): Promise<AccountInfo>;
  /** Plan 05+: refresh an expiring token. Throws TokenInvalidError when unrefreshable. */
  refreshToken(tokens: TokenSet): Promise<TokenSet>;
  /** Publish a normalized request to the given platform account. */
  publish(args: {
    tokens: TokenSet;
    accountId: string;
    request: PublishRequest;
    mediaUrls: string[];
    /** Channel-level provider data (e.g. Meta { subKind: "facebook_page" | "instagram" }) for routing. */
    channelMetadata?: Record<string, unknown>;
  }): Promise<PublishHandle>;
  /**
   * STORY1 (capability-gated, duck-typed): publish a pre-rendered 9:16 image as a Story to this
   * account. IG = `media_type=STORIES` container → `media_publish`; FB Page = unpublished photo →
   * `photo_stories`. `mediaUrl` MUST be a public URL the platform can pull. Absence = the platform
   * has no Story-publish path (so the auto-Story hook skips it).
   */
  publishStory?(args: {
    tokens: TokenSet;
    accountId: string;
    mediaUrl: string;
    channelMetadata?: Record<string, unknown>;
  }): Promise<PublishHandle>;
  publishStatus?(tokens: TokenSet, handle: PublishHandle): Promise<PublishStatus>;
  /** Optional crash-recovery: did a prior attempt land? Engine prefers it; absence -> unknown. */
  reconcile?(tokens: TokenSet, handle: PublishHandle): Promise<"sent" | "not_sent" | "unknown">;
  refreshWindowSeconds?(): number;
  rateLimit?(): { perMinute?: number; perDay?: number };
  /** Optional (capability-gated): OAuth2 authorization-code config for the admin connect flow. */
  oauthConfig?(): OAuthConfig | undefined;
  /** Optional (capability-gated): this provider can manage sub-accounts from one master token. */
  supportsSources?(): boolean;
  /** Introspect a master token (type, data-access window, scopes). Throws TokenInvalidError if dead. */
  inspectSource?(master: TokenSet): Promise<SourceInfo>;
  /** Enumerate sub-accounts and mint a token for each. Throws TokenInvalidError if the master is dead. */
  enumerateSubAccounts?(master: TokenSet): Promise<SubAccount[]>;
}
