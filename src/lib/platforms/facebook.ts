import { env } from "@/lib/env";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
} from "./base";
import { expectedPageFields } from "./webhook-fields";
import { GRAPH_API_BASE, META_OAUTH_BASE } from "./constants";
import { inspectMetaToken, assertMetaScopes } from "./meta-token";
import { fetchAllManagedPages } from "./meta-graph";
import { assertMetaOk } from "./errors";
import { buildMessageObject } from "./message-payload";
import { asString } from "@/lib/providers/util";

const GRAPH_API = GRAPH_API_BASE;

interface FbPage {
  id: string;
  name: string;
  access_token: string;
  picture?: { data: { url: string } };
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
   * Connect a channel with a pasted token. Branches on the token type:
   *  - PAGE token → connect exactly that one Page (the FREE single-page path).
   *  - USER / System User token → enumerate ALL managed Pages (the managed path).
   * Rejects a foreign-app / invalid / expired / under-scoped token up front with a SPECIFIC message
   * (via inspectMetaToken / assertMetaScopes) instead of storing it and dead-lettering every send.
   */
  override async connectWithToken(token: string): Promise<ConnectedAccount[]> {
    const info = await inspectMetaToken(token);
    if (info?.kind === "page") return this.fetchSinglePage(token);
    // Enumeration needs a user-level token that can list the Pages.
    assertMetaScopes(info, ["pages_show_list"], "Facebook");
    return this.fetchPageAccounts(token);
  }

  /** Connect the single Page a PAGE token is scoped to (GET /me with a page token = that page). */
  private async fetchSinglePage(pageToken: string): Promise<ConnectedAccount[]> {
    const res = await fetch(
      `${GRAPH_API}/me?` +
        new URLSearchParams({ access_token: pageToken, fields: "id,name,picture" }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to load Facebook page for this token: ${body}`);
    }
    const page = (await res.json()) as FbPage;
    return [
      {
        platformId: page.id,
        displayName: page.name,
        profilePicture: page.picture?.data?.url,
        tokens: { access_token: pageToken }, // page tokens don't expire
      },
    ];
  }

  /** Resolve the Pages a user/System User token manages → connected accounts. Paginates the
   *  me/accounts edge so a managed connection with many Pages isn't truncated to the first response
   *  page, and skips an entry we can't mint (no page token) or a malformed id (PSA55). */
  private async fetchPageAccounts(userToken: string): Promise<ConnectedAccount[]> {
    const pages = await fetchAllManagedPages<FbPage>(userToken, "id,name,access_token,picture");
    const accounts: ConnectedAccount[] = [];
    for (const page of pages) {
      const id = asString(page.id);
      if (!id || !page.access_token) continue;
      accounts.push({
        platformId: id,
        displayName: page.name,
        profilePicture: page.picture?.data?.url,
        tokens: {
          access_token: page.access_token,
          // Facebook page tokens don't expire
        },
      });
    }
    return accounts;
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

    // assertMetaOk passed (2xx) → the send was accepted. A proxy/CDN can still return an empty or
    // non-JSON 2xx body; parse defensively so we don't throw AFTER acceptance (which would retry and
    // double-send), treating an unparseable body as sent with an unknown message id.
    const data = (await res.json().catch(() => ({}))) as { message_id?: string };
    return { platformMessageId: data.message_id ?? null };
  }

  async sendComment(
    tokens: TokenData,
    objectId: string,
    message: string
  ): Promise<{ platformMessageId: string | null }> {
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
    // POST /{object}/comments returns { id: "<new comment id>" } — capture it for the ledger.
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { platformMessageId: data.id ?? null };
  }

  /**
   * Post a NEW top-level comment on one of our own Page posts (the "first comment"). On Facebook the
   * top-level edge is `POST /{post-id}/comments` — the SAME endpoint {@link sendComment} uses — so we
   * delegate to it rather than duplicate the request (DRY). (On IG/YouTube the two diverge, which is
   * why `commentOnPost` is its own method on the base class.)
   */
  override async commentOnPost(
    tokens: TokenData,
    postId: string,
    message: string,
  ): Promise<{ platformMessageId: string | null }> {
    return this.sendComment(tokens, postId, message);
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
  ): Promise<boolean> {
    const res = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // WEBHOOKSUB1: complete page field set from the single source of truth, so a connect always
        // auto-configures the full set (echoes / reactions / receipts), never a partial subscription.
        subscribed_fields: expectedPageFields("facebook").join(","),
        access_token: pageAccessToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[facebook] Webhook subscription failed for page ${pageId}:`, body);
      // Non-fatal — channel is still usable, webhooks can be set up manually. The caller flags the
      // channel so the failed subscribe (no inbound) is visible, not silent.
      return false;
    }
    return true;
  }
}
