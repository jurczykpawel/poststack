import { getConfig } from "@/lib/settings/config";
import {
  SocialProvider,
  type TokenData,
  type ConnectedAccount,
  type MessageContent,
  type SentMessage,
  type SendMessageOptions,
  type UserProfile,
} from "./base";
import { expectedPageFields, instagramLoginFields } from "./webhook-fields";
import { GRAPH_API_BASE, IG_GRAPH_BASE, META_OAUTH_BASE } from "./constants";
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
  instagram_business_account?: {
    id: string;
    name: string;
    username: string;
    profile_picture_url: string;
  };
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
  readonly appConfigEnvVar = "META_APP_ID";

  /**
   * Choose the messaging transport. When the channel carries an Instagram-Login messaging token
   * (`messaging_token`, an IGQW token from Instagram Business Login), route to `graph.instagram.com`
   * (IG_GRAPH_BASE) with THAT token — validated LIVE at Standard Access, no App Review. Otherwise
   * fall back to the FB page token on `graph.facebook.com` (the managed / Advanced-Access path).
   * Applies to the messaging surface only (sendMessage, getUserProfile, checkFollowsBusiness,
   * sendPrivateReply); comments / permalink route via {@link contentTransport} (FB token unless
   * IG-Login-only); publishing via igPublishTransport.
   */
  private messagingTransport(tokens: TokenData): { base: string; token: string } {
    const ig = tokens.messaging_token as string | undefined;
    return ig
      ? { base: IG_GRAPH_BASE, token: ig }
      : { base: GRAPH_API, token: tokens.access_token };
  }

  /**
   * Choose the transport for IG CONTENT operations (comments + permalink). Mirrors
   * {@link igPublishTransport} in the publish provider, NOT {@link messagingTransport}: a channel that
   * still has a Facebook page token keeps using it on graph.facebook.com (the proven managed path) —
   * only an IG-Login-ONLY channel (empty access_token) routes to graph.instagram.com with the IG-Login
   * token. Docs: IG-Login comment moderation uses identical paths on graph.instagram.com under
   * instagram_business_manage_comments (already requested). Messaging differs (it always prefers the
   * IG-Login token) because IG DM delivery requires graph.instagram.com at Standard Access.
   */
  private contentTransport(tokens: TokenData): { base: string; token: string } {
    const ig = tokens.messaging_token as string | undefined;
    return ig && !tokens.access_token
      ? { base: IG_GRAPH_BASE, token: ig }
      : { base: GRAPH_API, token: tokens.access_token };
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<string> {
    const params = new URLSearchParams({
      client_id: await getConfig("META_APP_ID"),
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
          client_id: await getConfig("META_APP_ID"),
          client_secret: await getConfig("META_APP_SECRET"),
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
          client_id: await getConfig("META_APP_ID"),
          client_secret: await getConfig("META_APP_SECRET"),
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
   * Connect a channel with a pasted token. Branches on the token type:
   *  - PAGE token → connect the IG business account linked to that one Page (FREE single path).
   *  - USER / System User token → enumerate ALL linked IG business accounts (managed path).
   * Rejects a foreign-app / invalid / expired / under-scoped token up front with a SPECIFIC message.
   */
  override async connectWithToken(token: string): Promise<ConnectedAccount[]> {
    const info = await inspectMetaToken(token);
    if (info?.kind === "page") return this.fetchSingleIgAccount(token);
    assertMetaScopes(info, ["pages_show_list", "instagram_basic"], "Instagram");
    return this.fetchIgAccounts(token);
  }

  /** Connect the IG business account linked to the single Page a PAGE token is scoped to. */
  private async fetchSingleIgAccount(pageToken: string): Promise<ConnectedAccount[]> {
    const res = await fetch(
      `${GRAPH_API}/me?` +
        new URLSearchParams({
          access_token: pageToken,
          fields: "id,name,instagram_business_account{id,name,username,profile_picture_url}",
        }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to load Instagram account for this token: ${body}`);
    }
    const page = (await res.json()) as FbPage;
    const ig = page.instagram_business_account;
    if (!ig) return [];
    return [
      {
        platformId: ig.id,
        displayName: ig.name ?? ig.username,
        username: ig.username,
        profilePicture: ig.profile_picture_url,
        tokens: { access_token: pageToken, page_id: page.id }, // page token, non-expiring
      },
    ];
  }

  /** Resolve IG business accounts behind a user/System User token's Pages. Paginates the me/accounts
   *  edge so a managed connection with many Pages isn't truncated, and skips a Page with no linked IG
   *  account, no page token, or a malformed IG id (PSA55). */
  private async fetchIgAccounts(
    userToken: string,
    expiresAt?: number,
  ): Promise<ConnectedAccount[]> {
    const pages = await fetchAllManagedPages<FbPage>(
      userToken,
      "id,name,access_token,instagram_business_account{id,name,username,profile_picture_url}",
    );

    const accounts: ConnectedAccount[] = [];
    for (const page of pages) {
      const igAccount = page.instagram_business_account;
      const igId = asString(igAccount?.id);
      if (!igAccount || !igId || !page.access_token) continue;

      accounts.push({
        platformId: igId,
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
          client_id: await getConfig("META_APP_ID"),
          client_secret: await getConfig("META_APP_SECRET"),
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

  /**
   * IGML6 (life-support): refresh the long-lived Instagram-Login messaging token (the IGQW
   * `messaging_token`) on its own 60-day clock — independent of the FB page/user token that
   * {@link refreshToken} handles. A dead IG-Login token silently kills IG DMs (a real channel died
   * exactly this way), so the refresh scan/worker call this ~10 days before expiry.
   *
   * Hits the UNVERSIONED refresh endpoint on the graph.instagram.com origin
   * (`/refresh_access_token?grant_type=ig_refresh_token`), derived from IG_GRAPH_BASE's origin so the
   * version literal stays only in constants.ts (guarded by version-source.test.ts). On a rejected /
   * expired token assertMetaOk throws TokenInvalidError → the worker flags the channel needs_reauth.
   */
  override async refreshMessagingToken(igToken: string): Promise<{ token: string; expiresAt: number }> {
    const url =
      `${new URL(IG_GRAPH_BASE).origin}/refresh_access_token?` +
      new URLSearchParams({ grant_type: "ig_refresh_token", access_token: igToken }).toString();
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    await assertMetaOk(res, "Instagram messaging token refresh");
    const d = (await res.json()) as { access_token: string; expires_in: number };
    return { token: d.access_token, expiresAt: Math.floor(Date.now() / 1000) + d.expires_in };
  }

  async sendMessage(
    tokens: TokenData,
    recipientId: string,
    content: MessageContent,
    opts?: SendMessageOptions
  ): Promise<SentMessage> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      // Outside the 24h window a human reply rides the HUMAN_AGENT tag (valid up to 7 days);
      // otherwise the standard RESPONSE type. See ./messaging-window.
      ...(opts?.messagingTag
        ? { messaging_type: "MESSAGE_TAG", tag: opts.messagingTag }
        : { messaging_type: "RESPONSE" }),
      // Instagram does not render image_url on quick replies, so it is stripped.
      message: buildMessageObject(content, { allowQuickReplyImages: false }),
    };

    // Route via IG-Login (graph.instagram.com) when the channel has an IG-Login messaging token;
    // otherwise the FB page token scoped to the IG account (graph.facebook.com).
    const { base, token } = this.messagingTransport(tokens);
    const res = await fetch(`${base}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram send message");

    // 2xx → accepted. Parse defensively so an empty/non-JSON 2xx body from a proxy doesn't throw
    // after acceptance and trigger a retry/double-send; treat it as sent, id unknown.
    const data = (await res.json().catch(() => ({}))) as { message_id?: string };
    return { platformMessageId: data.message_id ?? null };
  }

  /** Resolve an IGSID's public profile (name/username/avatar). Best-effort: null on any failure so a
   *  name lookup never blocks message processing. */
  async getUserProfile(tokens: TokenData, userId: string): Promise<UserProfile | null> {
    try {
      const { base, token } = this.messagingTransport(tokens);
      const res = await fetch(
        `${base}/${encodeURIComponent(userId)}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`,
        { redirect: "error", signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return null;
      const d = (await res.json().catch(() => null)) as { name?: string; username?: string; profile_pic?: string } | null;
      if (!d?.name && !d?.username) return null;
      return { name: d.name, username: d.username, profilePicture: d.profile_pic };
    } catch {
      return null;
    }
  }

  async sendComment(
    tokens: TokenData,
    mediaId: string,
    message: string
  ): Promise<{ platformMessageId: string | null }> {
    const { base, token } = this.contentTransport(tokens);
    const res = await fetch(`${base}/${mediaId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram send comment");
    // POST /{media}/replies returns { id: "<new comment id>" } — capture it for the ledger.
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { platformMessageId: data.id ?? null };
  }

  /**
   * Post a NEW top-level comment on one of our own IG media (the "first comment"). Uses
   * `POST /{ig-media-id}/comments` — NOT `/{comment-id}/replies` (that's {@link sendComment},
   * which replies under someone else's comment).
   */
  override async commentOnPost(
    tokens: TokenData,
    mediaId: string,
    message: string,
  ): Promise<{ platformMessageId: string | null }> {
    const { base, token } = this.contentTransport(tokens);
    const res = await fetch(`${base}/${mediaId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    await assertMetaOk(res, "Instagram comment on post");
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { platformMessageId: data.id ?? null };
  }

  /**
   * Resolve an IG media id to its public permalink (`https://www.instagram.com/(p|reel|tv)/<code>/`).
   * IG media ids carry no shortcode, so the only reliable source is the API's `permalink` field.
   */
  override async getPostUrl(tokens: TokenData, mediaId: string): Promise<string | null> {
    const { base, token } = this.contentTransport(tokens);
    const res = await fetch(
      `${base}/${mediaId}?` + new URLSearchParams({ fields: "permalink", access_token: token }),
      { redirect: "error", signal: AbortSignal.timeout(10_000) },
    );
    await assertMetaOk(res, "Instagram get post url");
    const data = (await res.json().catch(() => ({}))) as { permalink?: string };
    return data.permalink ?? null;
  }

  override async sendPrivateReply(
    tokens: TokenData,
    commentId: string,
    content: MessageContent
  ): Promise<SentMessage> {
    const { base, token } = this.messagingTransport(tokens);
    const res = await fetch(`${base}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: buildMessageObject(content, { allowQuickReplyImages: false }),
        access_token: token,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    await assertMetaOk(res, "Instagram private reply");

    // Capture the message id so the echo of our own send (THREADSYNC1) dedups against this row
    // instead of being recorded as a duplicate outbound message. Parse defensively (see sendMessage).
    const data = (await res.json().catch(() => ({}))) as { message_id?: string };
    return { platformMessageId: data.message_id ?? null };
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
    const { base, token } = this.messagingTransport(tokens);
    const res = await fetch(
      `${base}/${userId}?` +
        new URLSearchParams({
          fields: "is_user_follow_business",
          access_token: token,
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
        // WEBHOOKSUB1: complete page field set from the single source of truth. NOTE: `comments` is a
        // `page` field only on paper — Graph rejects it (#100), so IG media-comment webhooks instead
        // ride the APP-level `instagram` object subscription, not a page field. Sending it here would
        // fail the whole subscribed_apps POST atomically, so it is intentionally excluded.
        subscribed_fields: expectedPageFields("instagram").join(","),
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

  /**
   * IGFU2: subscribe an Instagram account to messaging webhooks the Instagram-Business-Login-native
   * way — a PER-ACCOUNT `subscribed_apps` POST on `graph.instagram.com` with the IGQW user token
   * (NOT a Facebook Page subscription). This is the inbound path for an IG-Login-only channel: with
   * no Facebook Page behind it, {@link subscribePageWebhooks} can't run, so without this call the
   * account silently receives no DMs (exactly the manual fix that was applied for a live account).
   *
   * Idempotent: re-subscribing an already-subscribed account is a no-op success, so it's safe to call
   * on every connect (including the augment-an-existing-FB-channel case). Returns whether it
   * succeeded so the caller can flag a channel whose only inbound path failed, instead of leaving a
   * misleading "active". The version literal stays in constants.ts (IG_GRAPH_BASE) — never inline
   * `graph.instagram.com/vNN` (guarded by version-source.test.ts).
   *
   * SECURITY: Meta accepts the token only as a query param on this host (mirrors the IG-Login
   * exchange), so the IGQW token is in the URL — outbound-request URL logging must stay OFF around
   * this call, or the token would leak into logs.
   */
  async subscribeMessagingWebhooks(igToken: string, igUserId: string): Promise<boolean> {
    const params = new URLSearchParams({
      // Widened to the IG-Login parity set (incl. `comments`) so an IG-Login-only channel also
      // receives comment webhooks for comment→DM. Single source of truth in webhook-fields.
      subscribed_fields: instagramLoginFields().join(","),
      access_token: igToken,
    });
    const res = await fetch(`${IG_GRAPH_BASE}/${encodeURIComponent(igUserId)}/subscribed_apps?${params.toString()}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[instagram] IG-Login messaging webhook subscription failed for ${igUserId}:`, body);
      return false; // caller flags the channel so a silent no-inbound state is visible
    }
    return true;
  }
}
