import { env } from "@/lib/env";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";
import { GRAPH_API_BASE, META_OAUTH_BASE } from "./constants";
import { assertMetaOk } from "./errors";
import { buildMessageObject } from "./message-payload";

const GRAPH_API = GRAPH_API_BASE;

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  picture?: { data: { url: string } };
}

interface FbPagesResponse {
  data: FbPage[];
}

interface FbUserToken {
  access_token: string;
  token_type: string;
}

interface FbDebugToken {
  data: {
    expires_at: number;
    is_valid: boolean;
  };
}

export class FacebookProvider extends SocialProvider {
  readonly platform = "facebook" as const;
  readonly displayName = "Facebook";

  generateAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: env.META_APP_ID,
      redirect_uri: redirectUri,
      state,
      scope: [
        "pages_show_list",
        "pages_messaging",
        "pages_read_engagement",
        "pages_manage_metadata",
      ].join(","),
      response_type: "code",
    });
    return `${META_OAUTH_BASE}/dialog/oauth?${params.toString()}`;
  }

  async authenticate(code: string, redirectUri: string): Promise<ConnectedAccount[]> {
    // 1. Exchange code for user access token
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
    const userToken = (await tokenRes.json()) as FbUserToken;

    // 2. Fetch pages the user manages
    return this.fetchPageAccounts(userToken.access_token);
  }

  /**
   * Connect a channel with a pasted long-lived / System User token (REL4).
   * The token itself resolves the managed Pages; page tokens are non-expiring.
   */
  override async connectWithToken(token: string): Promise<ConnectedAccount[]> {
    return this.fetchPageAccounts(token);
  }

  /** Resolve the Pages a user/System User token manages → connected accounts. */
  private async fetchPageAccounts(userToken: string): Promise<ConnectedAccount[]> {
    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?` +
        new URLSearchParams({
          access_token: userToken,
          fields: "id,name,access_token,picture",
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    if (!pagesRes.ok) {
      const body = await pagesRes.text();
      throw new Error(`Failed to fetch Facebook pages: ${body}`);
    }
    const pages = (await pagesRes.json()) as FbPagesResponse;

    return pages.data.map((page) => ({
      platformId: page.id,
      displayName: page.name,
      profilePicture: page.picture?.data?.url,
      tokens: {
        access_token: page.access_token,
        // Facebook page tokens don't expire
      },
    }));
  }

  async refreshToken(tokens: TokenData): Promise<TokenData> {
    // Facebook page tokens are permanent — nothing to refresh
    return tokens;
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent
  ): Promise<SentMessage> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      messaging_type: "RESPONSE",
      // Messenger renders image_url on quick replies.
      message: buildMessageObject(content, { allowQuickReplyImages: true }),
    };

    const res = await fetch(`${GRAPH_API}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: tokens.access_token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Facebook send message");

    const data = (await res.json()) as { message_id: string };
    return { platformMessageId: data.message_id };
  }

  async sendComment(
    tokens: TokenData,
    objectId: string,
    message: string
  ): Promise<void> {
    const res = await fetch(`${GRAPH_API}/${objectId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        access_token: tokens.access_token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Facebook send comment");
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
        message: buildMessageObject(content, { allowQuickReplyImages: true }),
        access_token: tokens.access_token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Facebook private reply");
  }

  /**
   * Verify token is still valid and check expiry via debug_token.
   * Returns expiry timestamp if available, else undefined.
   */
  async getTokenExpiry(pageToken: string): Promise<number | undefined> {
    const res = await fetch(
      `${GRAPH_API}/debug_token?` +
        new URLSearchParams({
          input_token: pageToken,
          access_token: `${env.META_APP_ID}|${env.META_APP_SECRET}`,
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as FbDebugToken;
    return data.data.expires_at || undefined;
  }

  requiresTokenRefresh(): boolean {
    return false;
  }

  /**
   * Subscribe a Facebook Page to webhook events so we receive messages,
   * postbacks, and feed updates automatically.
   *
   * Called after OAuth — saves the user from manually configuring
   * webhooks in Meta's developer console.
   *
   * POST /{page-id}/subscribed_apps
   * https://developers.facebook.com/docs/graph-api/reference/page/subscribed_apps/
   */
  async subscribePageWebhooks(
    pageId: string,
    pageAccessToken: string
  ): Promise<void> {
    const res = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscribed_fields: [
          "messages",
          "messaging_postbacks",
          "messaging_optins",
          "feed",
        ].join(","),
        access_token: pageAccessToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[facebook] Webhook subscription failed for page ${pageId}:`, body);
      // Non-fatal — channel is still usable, webhooks can be set up manually
    }
  }
}
