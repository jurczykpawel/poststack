import type { Platform } from "@/db/schema";
import type { Capability } from "@/lib/channels/capabilities";

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  [key: string]: unknown;
}

export interface ConnectedAccount {
  platformId: string;
  displayName: string;
  username?: string;
  profilePicture?: string;
  tokens: TokenData;
}

export interface QuickReply {
  /** "text" (tappable, returns payload) | "user_email" | "user_phone_number" (pre-filled from profile). Defaults to "text". */
  content_type?: "text" | "user_email" | "user_phone_number";
  /** Required for text quick replies (≤20 chars). Omitted for user_email/user_phone_number. */
  title?: string;
  payload?: string;
  /** Icon next to a text quick reply. Messenger only — Instagram does not render it. */
  image_url?: string;
}

export interface MessageButton {
  title: string;
  /** postback button: returned to the postback trigger on tap. */
  payload?: string;
  /** web_url button: opens the URL. */
  url?: string;
}

export interface MessageContent {
  text?: string;
  attachments?: Array<{ type: string; url: string }>;
  quick_replies?: QuickReply[];
  buttons?: MessageButton[];
}

export interface SentMessage {
  /** null when the provider returned 2xx but no parseable message id. */
  platformMessageId: string | null;
}

/**
 * Base class for all social media platform providers.
 * Each platform implements this interface.
 *
 * To add a new platform:
 * 1. Create src/lib/platforms/{platform}.ts extending SocialProvider
 * 2. Implement all abstract methods
 * 3. Register in src/lib/platforms/registry.ts
 * 4. Add OAuth callback route in src/server/handlers/oauth/{platform}/route.ts
 * 5. Add the platform to the platform enum in src/db/schema.ts
 */
export abstract class SocialProvider {
  abstract readonly platform: Platform;
  abstract readonly displayName: string;

  /**
   * Generate the OAuth authorization URL to redirect the user to.
   * @param state - Random state string (store in session to verify on callback)
   * @param redirectUri - The callback URL registered in the platform's developer console
   */
  abstract generateAuthUrl(state: string, redirectUri: string): string;

  /**
   * Exchange authorization code for tokens and fetch account info.
   * Called on OAuth callback.
   */
  abstract authenticate(
    code: string,
    redirectUri: string
  ): Promise<ConnectedAccount[]>;

  /**
   * Connect using a pasted long-lived / System User token instead of OAuth.
   * Validates the token by resolving the accounts it manages; the returned
   * tokens are non-expiring (no expires_at), so the refresh worker leaves them
   * alone. Optional — only platforms that support it implement this.
   */
  connectWithToken?(token: string): Promise<ConnectedAccount[]>;

  /**
   * Refresh an expired access token.
   * Not all platforms support this - throw if not supported.
   */
  abstract refreshToken(tokens: TokenData): Promise<TokenData>;

  /**
   * Send a DM to a conversation.
   * @param tokens - Decrypted channel tokens
   * @param recipientId - Platform-native recipient ID (PSID, IG user ID, etc.)
   * @param content - Message content
   */
  abstract sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent
  ): Promise<SentMessage>;

  /**
   * Post a public comment reply.
   * Meta-native — optional. Platforms without a comment surface (Telegram,
   * Email, SMS) omit it; the outgoing-comment worker guards on its presence.
   * @param tokens - Decrypted channel tokens
   * @param objectId - The comment or post ID to reply to
   * @param message - Reply text
   */
  sendComment?(
    tokens: TokenData,
    objectId: string,
    message: string
  ): Promise<{ platformMessageId: string | null }>;

  /**
   * Post a NEW top-level comment ON our own just-published post/media/video — the "first comment"
   * (link-in-first-comment / CTA / hashtags). Distinct from {@link sendComment}, which replies UNDER
   * an existing comment (IG `/{comment-id}/replies`, YouTube `comments.insert`). Top-level needs a
   * DIFFERENT endpoint per platform:
   *   - Facebook: `POST /{post-id}/comments`,
   *   - Instagram: `POST /{ig-media-id}/comments` (NOT `/replies`),
   *   - YouTube: `commentThreads.insert` (NOT `comments.insert`).
   * Optional / duck-typed (like {@link sendComment}). This is the DRY extension point — a new
   * publishing platform implements it and the first-comment worker picks it up with no other change.
   * @param postId - Platform-native id of the just-published post/media/video
   */
  commentOnPost?(
    tokens: TokenData,
    postId: string,
    message: string
  ): Promise<{ platformMessageId: string | null }>;

  /**
   * Send a private reply (comment-to-DM), addressed by comment_id.
   * Accepts full message content so first-touch DMs can carry quick replies /
   * buttons, not just text.
   * Optional - only some platforms support this (e.g. Instagram, Facebook).
   */
  sendPrivateReply?(
    tokens: TokenData,
    commentId: string,
    content: MessageContent
  ): Promise<void>;

  /**
   * Resolve a post/media id to its public permalink.
   * Optional — only platforms whose ids don't map to a URL by construction implement it
   * (Instagram media ids carry no public-URL shortcode; Facebook post ids do, so it builds the
   * URL at render time without a call). Best-effort: returns null when the platform has no
   * permalink for the id. Used to make the "on post" link in the inbox clickable.
   * @param postId - Platform-native post/media id
   */
  getPostUrl?(tokens: TokenData, postId: string): Promise<string | null>;

  /**
   * Whether a user follows the connected business account.
   * Used by the follow-gate. Optional — only platforms with a follow graph
   * implement it (Instagram). Platforms without one leave the gate open.
   * @param userId - Platform-native id of the user (PSID / IG-scoped id)
   */
  checkFollowsBusiness?(tokens: TokenData, userId: string): Promise<boolean>;

  /**
   * Whether tokens from this provider need periodic refresh.
   * Facebook page tokens are permanent; Instagram tokens expire in 60 days.
   */
  abstract requiresTokenRefresh(): boolean;

  /**
   * Subscribe a page/account to webhook events after OAuth.
   * Saves users from manually configuring webhooks in the platform's developer console.
   * Optional — not all platforms support this. Returns whether the subscription succeeded, so the
   * caller can surface a failed subscribe (an active channel that silently receives no inbound)
   * instead of leaving it invisible.
   */
  subscribePageWebhooks?(
    pageId: string,
    pageAccessToken: string
  ): Promise<boolean>;

  /**
   * How many seconds before expiry to refresh (used by token refresh worker).
   * Only relevant if requiresTokenRefresh() returns true.
   */
  refreshBufferSeconds(): number {
    return 7 * 24 * 60 * 60; // 7 days before expiry
  }

  /**
   * Capability probe (duck-typed on optional method presence) so callers can
   * branch before enqueuing platform-specific work.
   */
  supportsFeature(feature: "comments" | "comment_on_post" | "private_reply" | "token_connect" | "follow_check"): boolean {
    switch (feature) {
      case "comments":
        return typeof this.sendComment === "function";
      case "comment_on_post":
        return typeof this.commentOnPost === "function";
      case "private_reply":
        return typeof this.sendPrivateReply === "function";
      case "token_connect":
        return typeof this.connectWithToken === "function";
      case "follow_check":
        return typeof this.checkFollowsBusiness === "function";
    }
  }

  /**
   * The INBOUND channel capabilities this provider grants (CHANNELS-ARCHITECTURE Task 6). The
   * provider owns this — the channel capability resolver folds it together with the publish-side
   * capability so the engine can ask `can(channel, "dm")` without any platform branch. Default is
   * derived from method presence: every provider sends DMs (`sendMessage` is core), comment-reply
   * and webhook-subscription are duck-typed. Platforms that diverge (e.g. YouTube has no DM, polls
   * instead of receiving webhooks) override this.
   */
  inboundCapabilities(): Capability[] {
    const caps: Capability[] = ["dm"];
    if (this.supportsFeature("comments")) caps.push("comment_reply");
    if (typeof this.subscribePageWebhooks === "function") caps.push("receive_webhooks");
    return caps;
  }
}
