# Meta Connections — every way to connect Facebook/Instagram, and how their tokens live and die

PostStack has **five** distinct ways to connect a Facebook Page or Instagram account. They share
one Graph API and one webhook endpoint, but differ in which app credentials they use, which host
they talk to, what they unlock, and — the thing that actually causes support tickets — how long
their tokens last and whether PostStack refreshes them automatically.

This document is the map. It doesn't repeat setup steps that already live elsewhere — it tells you
which path you're looking at and links to the page with the actual click-by-click instructions.

---

## The five paths

| # | Path | How you start it | App credentials | Host | What works |
|---|---|---|---|---|---|
| A | **Facebook Login OAuth** ("+ Facebook") | Channels page → **+ Facebook** → Meta's OAuth dialog | `META_APP_ID` / `META_APP_SECRET` | `graph.facebook.com` | Publish (posts/photos/videos/reels), first comment + comment replies, Messenger DM inbox + auto-reply, comment→DM |
| B | **Instagram via Facebook Login** ("+ Instagram") | Channels page → **+ Instagram** → same OAuth dialog, Instagram-flavored scopes | `META_APP_ID` / `META_APP_SECRET` | `graph.facebook.com` | Publish to Instagram, comment reading + replies — **not** Instagram DMs |
| C | **Instagram Business Login** ("+ Instagram (messaging)") | Channels page → **+ Instagram (messaging)** | `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` (separate app credentials) | `graph.instagram.com` | Instagram DM inbox + auto-reply, comment→DM. Augments an existing path-B channel with a `messaging_token`, or creates an IG-Login-only channel if none exists yet |
| D | **Pasted token** (Channels form / API) | Channels page → paste a token, or `POST /api/v1/channels/connect-token` | `META_APP_ID` / `META_APP_SECRET` (used only to validate the token, via `debug_token`) | `graph.facebook.com` | Same as A (Page token) or same as A+B for both platforms in one paste (User/System User token) — everything the token's own scopes allow |
| E | **Managed connection / Sources** (`POST /api/v1/sources`) | Settings → Sources → paste a User or System User token (or the API) | `META_APP_ID` / `META_APP_SECRET` | `graph.facebook.com` | Same as D, but auto-enumerates and auto-syncs **every** Page + linked Instagram account the token can reach, keeps them in sync daily, and cascades re-auth to all of them from one master |

Detail per path:

- **A — Facebook Login OAuth.** `src/lib/platforms/facebook.ts`. Requests
  `FACEBOOK_OAUTH_SCOPES`: `pages_show_list`, `pages_messaging`, `pages_read_engagement`,
  `pages_manage_metadata`, `pages_manage_posts`, `pages_manage_engagement`, `publish_video`.
  Mints one channel per Page the user manages, each with the Page's own (non-expiring) token.
- **B — Instagram via Facebook Login.** `src/lib/platforms/instagram.ts`. Requests
  `INSTAGRAM_OAUTH_SCOPES`: `pages_show_list`, `pages_read_engagement`, `instagram_basic`,
  `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`. Despite
  requesting `instagram_manage_messages`, Instagram DMs are **not** delivered to a Facebook-Login
  connection at Standard Access — that's what path C is for. The channel stores the Page's token
  (`access_token`) plus the long-lived user token (`user_access_token`) that refreshes it.
- **C — Instagram Business Login.** `src/lib/platforms/instagram-login.ts`,
  `src/server/handlers/oauth/instagram-login/{route,callback/route}.ts`. Requests
  `IG_LOGIN_SCOPES`: `instagram_business_basic`, `instagram_business_manage_messages`,
  `instagram_business_manage_comments`, `instagram_business_content_publish`. The callback
  **augments** the existing Instagram channel for that account (`connection_mode` and Page token
  untouched) by writing a `messaging_token` — or, if no channel exists yet for that Instagram
  account, creates a minimal IG-Login-only channel. All messaging/comment calls on a channel that
  carries a `messaging_token` route to `graph.instagram.com` with that token instead of
  `graph.facebook.com` with the Page token (see `messagingTransport` / `contentTransport` in
  `instagram.ts`).
- **D — Pasted token.** `FacebookProvider.connectWithToken` / `InstagramProvider.connectWithToken`,
  `POST /api/v1/channels/connect-token` (needs an API key with `channels:write`), or the Channels
  page's paste form. `inspectMetaToken` classifies the pasted token via `debug_token`:
  - A **Page token** connects exactly that one Page (or its linked Instagram account) — the free,
    single-account path. No scope check beyond confirming the token belongs to this app.
  - A **User or System User token** enumerates **every** Page (and linked Instagram account) it can
    reach, requiring at least `pages_show_list` (Facebook) / `pages_show_list` +
    `instagram_basic` (Instagram). This is a **one-time** enumeration — reconnecting later means
    pasting the token again; nothing here syncs automatically (that's path E).
  Connects as `connection_mode: "manual_token"`.
- **E — Managed connection (Sources).** `src/lib/channels/account-source.ts`,
  `POST /api/v1/sources` (needs an API key with `sources:write`), Settings → Sources UI. **PRO
  feature** (`managed_connection`, gated by `proGate`). The pasted **master** token (User or System
  User; a Page token is rejected — "connects only one page") is stored, encrypted, in
  `account_sources`; every Page + linked Instagram account it can reach is minted as a `derived`
  channel pointing back at that source (`connection_mode: "derived"`). A daily cron
  (`source-sync-sweep` → `sweepAccountSources`) re-enumerates so a newly-added Page appears
  automatically and a reconnected master recovers everything at once. If the master token goes
  invalid, `markSourceNeedsReauth` cascades `needs_reauth` to every active derived channel in one
  shot — **one re-paste of the master token recovers them all**, instead of reconnecting each
  channel individually. Full setup walkthrough (the recommended self-host path):
  **[docs/META_SYSTEM_USER_SETUP.md](META_SYSTEM_USER_SETUP.md)**.

Setup steps (app products, redirect URIs, webhook subscriptions) for A, B and D live in
**[README → Meta App Setup](../README.md#meta-app-setup)**; C's setup lives in
**[README → Instagram Business Login](../README.md#instagram-business-login-required-for-instagram-dms)**;
E's lives in **[docs/META_SYSTEM_USER_SETUP.md](META_SYSTEM_USER_SETUP.md)**. This document
deliberately doesn't duplicate those steps.

---

## Which one should I use

- **Just want to publish + auto-reply on your own Page(s) and Instagram, self-hosting?** Start with
  **E (managed connection)** — one permanent System User token, everything auto-connects and stays
  in sync. It's the path this project is built to recommend for self-hosters.
- **Free tier, or only ever going to run one Page?** **A** (+ **B** if you also have Instagram).
  Simple OAuth, no extra app credentials.
- **Need Instagram DMs?** You need **C** on top of A/B (or on top of a path-E-derived Instagram
  channel) — no path delivers IG DMs at Standard Access without it.
- **Automating the connection from a script/CI, or don't want to click through OAuth?** **D**
  (single account) or **E** (everything, and it stays in sync) via the API.
- **Managing Pages that belong to other people (an agency/reseller setup)?** None of the above
  change that requirement — see README → Meta Access Levels. All five paths above assume you're
  connecting accounts you (or your Business) already administer.

---

## Token lifetimes and refresh

| Path | Token | Lifetime | Refreshed by PostStack? |
|---|---|---|---|
| A, B (Page side), D (Page token) | Page `access_token` | Does not expire (inherits the ~90-day data-access wall of the user who minted it, but the token string itself has no death clock) | N/A — never refreshed, `requiresTokenRefresh()` is `false` for Facebook |
| B | IG user token (`user_access_token`, stored alongside the Page token; its `expires_at` is what the channel tracks) | 60 days (long-lived) | Yes — hourly `token-refresh-scan` refreshes it ~10 days before expiry (`InstagramProvider.refreshBufferSeconds()`), via `fb_exchange_token`. The Page `access_token` itself is untouched by this refresh (it doesn't expire either way) |
| C | IG-Login messaging token (`messaging_token`, IGQW) | 60 days, **on its own clock**, tracked by the plaintext `messaging_token_expires_at` column | Yes — independently of the Page/user token above, refreshed via `refreshMessagingToken` (`ig_refresh_token` on `graph.instagram.com`) when a channel's `messaging_token_expires_at` is inside the buffer. Runs even for a channel whose Facebook side is a pasted/manual token |
| D | Pasted Page token | Same as A | Never — `connection_mode: "manual_token"` is skipped unconditionally by the refresh worker, before any provider-level check |
| D | Pasted User/System User token | Enumerated once at paste time. On Facebook the master token itself isn't kept — only the resulting Page tokens are. On Instagram it's persisted in every resulting channel's token blob as `user_access_token`, but that's dead weight: the field exists for the OAuth-refresh path, and a `manual_token` channel never reaches it | N/A — `connection_mode: "manual_token"` is skipped before any refresh call; reconnect means pasting again |
| E | Master User token | PostStack tracks only the **~90-day data-access wall** (`data_access_expires_at`, from Meta's `debug_token`) — it does not store or watch a separate token-life expiry for a source at all (unlike path B's `expires_at`). Meta's own long-lived user token also carries its usual ~60-day token life underneath, but nothing in this codebase reads or reacts to it for `account_sources` | **Not refreshed.** PostStack only re-enumerates (`source-sync-sweep`, daily) and proactively **alerts** (`managed-expiry-scan`, daily → `token_expiring`, `EXPIRY_WARNING_DAYS = 7`) before the data-access wall hits. A token refresh alone cannot reset that wall — the operator must re-paste a freshly logged-in token |
| E | Master System User token | Permanent — no expiry, no data-access wall (Meta reports no `expires_at` and no `data_access_expires_at`) | N/A — nothing to refresh, this is the set-and-forget shape |

A final one-time reminder (`channel_reauth_urgent`) fires ~24h before an OAuth channel's hard
`token_expires_at` if it's already `needs_reauth` and hasn't recovered — mainly relevant to
platforms that can't refresh programmatically; for Meta this is a backstop, not the normal path.

---

## Webhooks

All Facebook + Instagram webhook events (paths A, B, D, E) arrive at the **same** endpoint,
`POST /api/webhooks/meta`, verified against `x-hub-signature-256` tried against **both**
`META_APP_SECRET` and `INSTAGRAM_APP_SECRET` in turn (`verifyMetaSignatureAny`) — so a single
endpoint serves events signed by either app. Path C (Instagram Business Login) webhooks use the
**same** callback URL and verify token, configured separately in the Instagram app's own webhook
screen.

- A, B, D, E subscribe a Page's webhook fields automatically on connect/sync
  (`subscribeChannelWebhooks`); E re-subscribes on every daily sync so a newly-added Page starts
  receiving inbound immediately. D (`connect-token`) subscribes right after connecting, same as
  the OAuth paths — best-effort, so a subscribe failure flags the channel rather than failing the
  connect; the channel detail page's subscription-status check and its reconcile/"Fix" action
  (`reconcileChannelSubscription`) remain available to retry it later.
- C subscribes per-Instagram-account messaging webhooks (`subscribeInstagramMessaging`) — needed
  because an IG-Login-only channel has no Facebook Page subscription. If that subscribe fails but
  the channel still has a Page token, the channel is **not** downgraded (publishing/comments still
  work via the Page) — only a non-silent warning is recorded, because IG DMs specifically won't
  arrive.
- The app must be in **Live** mode to receive real (non-test) webhook events on any path — see
  README → Meta Access Levels.

---

## Alerts

One outbound webhook (per-workspace `alert_webhooks` row if configured, PRO; otherwise the
license-ungated `CHANNEL_ALERT_WEBHOOK_URL` env fallback) carries every alert class, discriminated
by `type`:

- `channel_reauth` — a channel (or, for path E, the whole managed source) flipped to
  `needs_reauth` on a confirmed-bad token.
- `channel_reauth_urgent` — the ~24h-before-hard-expiry final nudge described above.
- `channel_degraded` — still active but impaired (e.g. can publish but not receive a class of
  events — the IG-Login-subscribe-failed-but-Page-token-still-works case above).
- `token_expiring` — proactive, path-E-only today: a managed connection's data-access wall is
  within `EXPIRY_WARNING_DAYS` (7).

Each alert type is throttled per (type, channel|source) so a persistent failure can't storm the
webhook.

---

## Known limitation

**`channelCapabilities()` (`src/lib/channels/capabilities.ts`) currently grants the `publish`
capability to every Facebook/Instagram channel unconditionally** (`isPublishablePlatform(...)` →
`caps.add("publish")`), regardless of which scopes that specific channel's token actually carries.
A channel connected before the publishing scopes existed (see the `[Unreleased]` CHANGELOG entry)
will still show as able to publish in the UI/API even though Meta will reject the publish call with
an insufficient-permissions error until it's reconnected. Making `publish` scope-aware is tracked
as a separate, follow-up change — for now, **reconnect** (Channels → Reconnect, or re-paste the
token / master token) any channel connected before this document's scope additions before relying
on it to publish or post a first comment.
