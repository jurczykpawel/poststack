import { env } from "@/lib/env";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";

const GRAPH_API = "https://graph.facebook.com/v21.0";

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
    return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
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
    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?` +
        new URLSearchParams({
          access_token: userToken.access_token,
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
    };

    const message: Record<string, unknown> = {};

    if (content.attachments && content.attachments.length > 0) {
      // Send first attachment (Meta API supports one per message)
      const att = content.attachments[0];
      message.attachment = {
        type: att.type || "file",
        payload: { url: att.url, is_reusable: true },
      };
    } else if (content.text) {
      message.text = content.text;
    }

    if (content.quick_replies && content.quick_replies.length > 0) {
      message.quick_replies = content.quick_replies.map((qr) => ({
        content_type: "text",
        title: qr.title,
        payload: qr.payload,
      }));
    }

    if (content.buttons && content.buttons.length > 0 && content.text) {
      // Button template (replaces plain text)
      message.attachment = {
        type: "template",
        payload: {
          template_type: "button",
          text: content.text,
          buttons: content.buttons.map((btn) =>
            btn.url
              ? { type: "web_url", url: btn.url, title: btn.title }
              : { type: "postback", title: btn.title, payload: btn.payload ?? btn.title }
          ),
        },
      };
      delete message.text;
    }

    body.message = message;

    const res = await fetch(`${GRAPH_API}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: tokens.access_token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Facebook send message failed: ${err}`);
    }

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

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Facebook send comment failed: ${err}`);
    }
  }

  override async sendPrivateReply(
    tokens: TokenData,
    commentId: string,
    message: string
  ): Promise<void> {
    const res = await fetch(`${GRAPH_API}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text: message },
        access_token: tokens.access_token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Facebook private reply failed: ${err}`);
    }
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
}
