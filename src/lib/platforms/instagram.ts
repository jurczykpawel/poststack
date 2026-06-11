import { env } from "@/lib/env";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";
import { GRAPH_API_BASE, META_OAUTH_BASE } from "./constants";
import { assertMetaTokenBelongsToApp } from "./meta-token";
import { assertMetaOk } from "./errors";
import { buildMessageObject } from "./message-payload";

const GRAPH_API = GRAPH_API_BASE;

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: {
    id: string;
    name: string;
    username: string;
    profile_picture_url: string;
  };
}

interface FbPagesResponse {
  data: FbPage[];
}

interface FbUserToken {
  access_token: string;
}

interface LongLivedToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class InstagramProvider extends SocialProvider {
  readonly platform = "instagram" as const;
  readonly displayName = "Instagram";

  generateAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: env.META_APP_ID,
      redirect_uri: redirectUri,
      state,
      scope: [
        "pages_show_list",
        "pages_read_engagement",
        "instagram_basic",
        "instagram_manage_messages",
        "instagram_manage_comments",
      ].join(","),
      response_type: "code",
    });
    return `${META_OAUTH_BASE}/dialog/oauth?${params.toString()}`;
  }

  async authenticate(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    // 1. Exchange code for user token
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?` +
        new URLSearchParams({
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          redirect_uri: redirectUri,
          code,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      throw new Error(`Meta token exchange failed: ${body}`);
    }
    const { access_token: userToken } = (await tokenRes.json()) as FbUserToken;

    // 2. Exchange for long-lived token (valid 60 days)
    const llRes = await fetch(
      `${GRAPH_API}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: userToken,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    if (!llRes.ok) {
      const body = await llRes.text();
      throw new Error(`Meta long-lived token exchange failed: ${body}`);
    }
    const llToken = (await llRes.json()) as LongLivedToken;
    const expiresAt = Math.floor(Date.now() / 1000) + llToken.expires_in;

    // 3. Fetch FB pages with linked Instagram business accounts
    return this.fetchIgAccounts(llToken.access_token, expiresAt);
  }

  /**
   * Connect a channel with a pasted long-lived / System User token.
   * The token resolves the linked IG business accounts; tokens are stored
   * without an expiry so the refresh worker skips them.
   */
  override async connectWithToken(token: string): Promise<ConnectedAccount[]> {
    // Reject a foreign-app / invalid token up front with a clear message.
    await assertMetaTokenBelongsToApp(token);
    return this.fetchIgAccounts(token);
  }

  /** Resolve IG business accounts behind a user/System User token's Pages. */
  private async fetchIgAccounts(
    userToken: string,
    expiresAt?: number,
  ): Promise<ConnectedAccount[]> {
    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?` +
        new URLSearchParams({
          access_token: userToken,
          fields: "id,name,access_token,instagram_business_account{id,name,username,profile_picture_url}",
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    if (!pagesRes.ok) {
      const body = await pagesRes.text();
      throw new Error(`Failed to fetch Facebook pages: ${body}`);
    }
    const pages = (await pagesRes.json()) as FbPagesResponse;

    const accounts: ConnectedAccount[] = [];
    for (const page of pages.data) {
      const igAccount = page.instagram_business_account;
      if (!igAccount) continue;

      accounts.push({
        platformId: igAccount.id,
        displayName: igAccount.name ?? igAccount.username,
        username: igAccount.username,
        profilePicture: igAccount.profile_picture_url,
        tokens: {
          // Store FB page token — needed to send messages via Instagram Messaging API
          access_token: page.access_token,
          user_access_token: userToken,
          page_id: page.id,
          // expires_at only set for OAuth (60-day) tokens; omitted for manual tokens.
          ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        },
      });
    }

    return accounts;
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    // Refresh the long-lived user token (valid another 60 days from refresh)
    const res = await fetch(
      `${GRAPH_API}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: env.META_APP_ID,
          client_secret: env.META_APP_SECRET,
          fb_exchange_token: String(tokens.user_access_token ?? tokens.access_token),
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    await assertMetaOk(res, "Instagram token refresh");
    const data = (await res.json()) as LongLivedToken;
    return {
      ...tokens,
      user_access_token: data.access_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    };
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent
  ): Promise<SentMessage> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      // Instagram does not render image_url on quick replies, so it is stripped.
      message: buildMessageObject(content, { allowQuickReplyImages: false }),
    };

    // Instagram messaging uses the FB page token scoped to the IG account
    const res = await fetch(`${GRAPH_API}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: tokens.access_token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram send message");

    // 2xx → accepted. Parse defensively so an empty/non-JSON 2xx body from a proxy doesn't throw
    // after acceptance and trigger a retry/double-send; treat it as sent, id unknown.
    const data = (await res.json().catch(() => ({}))) as { message_id?: string };
    return { platformMessageId: data.message_id ?? null };
  }

  async sendComment(
    tokens: TokenData,
    mediaId: string,
    message: string
  ): Promise<{ platformMessageId: string | null }> {
    const res = await fetch(`${GRAPH_API}/${mediaId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        access_token: tokens.access_token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram send comment");
    // POST /{media}/replies returns { id: "<new comment id>" } — capture it for the ledger.
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { platformMessageId: data.id ?? null };
  }

  override async sendPrivateReply(
    tokens: TokenData,
    commentId: string,
    content: MessageContent
  ): Promise<void> {
    const res = await fetch(`${GRAPH_API}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: buildMessageObject(content, { allowQuickReplyImages: false }),
        access_token: tokens.access_token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram private reply");
  }

  /**
   * Whether the user follows the connected IG business account, via the
   * `is_user_follow_business` field on the user profile (IG Messaging API).
   * Drives the follow-gate.
   *
   * NOTE: the exact field/permission must be confirmed against a live IG
   * Business account before relying on it in production.
   */
  override async checkFollowsBusiness(tokens: TokenData, userId: string): Promise<boolean> {
    const res = await fetch(
      `${GRAPH_API}/${userId}?` +
        new URLSearchParams({
          fields: "is_user_follow_business",
          access_token: tokens.access_token,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    await assertMetaOk(res, "Instagram follow check");
    const data = (await res.json()) as { is_user_follow_business?: boolean };
    return data.is_user_follow_business === true;
  }

  requiresTokenRefresh(): boolean {
    return true; // Instagram long-lived tokens expire in 60 days
  }

  override refreshBufferSeconds(): number {
    return 10 * 24 * 60 * 60; // Refresh 10 days before expiry
  }

  /**
   * Subscribe the underlying Facebook Page to Instagram-related webhook events.
   * Instagram messaging webhooks are delivered through the Page subscription.
   *
   * Requires the page_id stored in tokens during OAuth.
   */
  async subscribePageWebhooks(
    pageId: string,
    pageAccessToken: string
  ): Promise<boolean> {
    const res = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // `comments` is required for IG media-comment webhooks (comment→DM / comment_keyword);
        // `feed` only covers Facebook-native feed comments, so without this IG comment
        // automation silently never fires.
        subscribed_fields: [
          "messages",
          "messaging_postbacks",
          "comments",
          "feed",
        ].join(","),
        access_token: pageAccessToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[instagram] Webhook subscription failed for page ${pageId}:`, body);
      return false; // caller flags the channel so a silent no-inbound state is visible
    }
    return true;
  }
}
