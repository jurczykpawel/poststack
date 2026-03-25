import type { Platform } from "@prisma/client";

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

export interface MessageContent {
  text?: string;
  attachments?: Array<{ type: string; url: string }>;
  quick_replies?: Array<{ title: string; payload: string }>;
  buttons?: Array<{ title: string; payload?: string; url?: string }>;
}

export interface SentMessage {
  platformMessageId: string;
}

/**
 * Base class for all social media platform providers.
 * Each platform implements this interface.
 *
 * To add a new platform:
 * 1. Create src/lib/platforms/{platform}.ts extending SocialProvider
 * 2. Implement all abstract methods
 * 3. Register in src/lib/platforms/registry.ts
 * 4. Add OAuth callback route in src/app/api/oauth/{platform}/route.ts
 * 5. Add the platform to the Platform enum in prisma/schema.prisma
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
   * @param tokens - Decrypted channel tokens
   * @param objectId - The comment or post ID to reply to
   * @param message - Reply text
   */
  abstract sendComment(
    tokens: TokenData,
    objectId: string,
    message: string
  ): Promise<void>;

  /**
   * Send a private reply (comment-to-DM).
   * Optional - only some platforms support this (e.g. Instagram, Facebook).
   */
  sendPrivateReply?(
    tokens: TokenData,
    commentId: string,
    message: string
  ): Promise<void>;

  /**
   * Whether tokens from this provider need periodic refresh.
   * Facebook page tokens are permanent; Instagram tokens expire in 60 days.
   */
  abstract requiresTokenRefresh(): boolean;

  /**
   * How many seconds before expiry to refresh (used by token refresh worker).
   * Only relevant if requiresTokenRefresh() returns true.
   */
  refreshBufferSeconds(): number {
    return 7 * 24 * 60 * 60; // 7 days before expiry
  }
}
