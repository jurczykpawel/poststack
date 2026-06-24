import { getConfig } from "@/lib/settings/config";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type SentMessage,
} from "./base";
import type { Capability } from "@/lib/channels/capabilities";
import { insertCommentReply, insertCommentThread, refreshGoogleAccessToken } from "@/lib/youtube/client";

/**
 * YouTube provider — comment automation only (no DMs on YouTube). Inbound comments are POLLED (see
 * src/lib/youtube/poll.ts), not webhooked; this provider covers the OUTBOUND reply path
 * (comments.insert) + Google token refresh. The DM-centric methods of SocialProvider are
 * unsupported and throw, so a mis-routed DM job fails loudly instead of silently no-opping.
 */
export class YouTubeProvider extends SocialProvider {
  readonly platform = "youtube" as const;
  readonly displayName = "YouTube";
  readonly appConfigEnvVar = "GOOGLE_CLIENT_ID";

  async generateAuthUrl(): Promise<string> {
    // Google OAuth is handled by the dedicated connect flow, not the generic provider URL builder.
    throw new Error("YouTube uses the Google OAuth connect flow");
  }

  async authenticate(): Promise<ConnectedAccount[]> {
    throw new Error("YouTube connects via the Google OAuth callback, not this method");
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : "";
    if (!refreshToken) throw new Error("No refresh token stored for this YouTube channel");
    const { accessToken, expiresAt } = await refreshGoogleAccessToken({
      refreshToken,
      clientId: await getConfig("GOOGLE_CLIENT_ID"),
      clientSecret: await getConfig("GOOGLE_CLIENT_SECRET"),
    });
    return { ...tokens, access_token: accessToken, expires_at: expiresAt };
  }

  async sendMessage(): Promise<SentMessage> {
    throw new Error("YouTube has no direct messages — only public comment replies");
  }

  /** No DM and no webhook on YouTube: inbound comments are polled (poll_comments), replies are public. */
  override inboundCapabilities(): Capability[] {
    return ["comment_reply", "poll_comments"];
  }

  /** Reply publicly to a comment (comments.insert). `objectId` is the parent comment id. */
  override async sendComment(
    tokens: TokenData,
    objectId: string,
    message: string,
  ): Promise<{ platformMessageId: string | null }> {
    const accessToken = await this.usableAccessToken(tokens);
    const { id } = await insertCommentReply({ parentId: objectId, text: message, accessToken });
    return { platformMessageId: id };
  }

  /** Post a NEW top-level comment on one of our own videos (the "first comment"). Uses
   *  commentThreads.insert (NOT comments.insert, which only replies UNDER an existing comment). */
  override async commentOnPost(
    tokens: TokenData,
    videoId: string,
    message: string,
  ): Promise<{ platformMessageId: string | null }> {
    const accessToken = await this.usableAccessToken(tokens);
    const { id } = await insertCommentThread({ videoId, text: message, accessToken });
    return { platformMessageId: id };
  }

  requiresTokenRefresh(): boolean {
    return true; // Google access tokens expire in ~1h
  }

  /** A non-expired access token: the stored one if still valid, else a freshly-refreshed one. */
  private async usableAccessToken(tokens: TokenData): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = typeof tokens.expires_at === "number" ? tokens.expires_at : 0;
    if (typeof tokens.access_token === "string" && tokens.access_token && expiresAt > now + 60) {
      return tokens.access_token;
    }
    const refreshed = await this.refreshToken(tokens);
    return refreshed.access_token;
  }
}
