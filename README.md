# PostStack

> Self-hosted social media management for Facebook, Instagram, YouTube, Telegram & Gmail -- publish & schedule posts, auto-reply to DMs, comments and emails, and run drip sequences, all from one place.

[![License: Elastic 2.0](https://img.shields.io/badge/License-Elastic_2.0-0077CC.svg)](LICENSE)
[![CI](https://github.com/jurczykpawel/poststack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/poststack/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Source Available](https://img.shields.io/badge/source-available-brightgreen)](LICENSE)

[API Docs](/api/docs) | [Issues](https://github.com/jurczykpawel/poststack/issues) | [Contributing](CONTRIBUTING.md)

> [!TIP]
> ### ✅ No verified / approved Meta app required
> To run PostStack on your **own** Facebook & Instagram accounts you do **not** need to pass **Meta
> App Review** or **Business Verification**. Every feature — inbox, auto-reply, comment→DM, drip
> sequences — works under Meta's default **Standard Access**. App Review is only needed if you
> operate **other people's** accounts (an agency / reseller setup).
>
> 👉 **[Meta Access Levels — what needs App Review (and what doesn't)](#meta-access-levels--what-needs-app-review-and-what-doesnt)**

---

## Why PostStack?

- **Self-hosted** -- your data stays on your server, not on someone else's SaaS
- **No per-contact fees** -- ManyChat charges $15-65/mo and scales with your audience. PostStack is a flat self-hosted cost, free to run yourself
- **No vendor lock-in** -- export your data, switch providers, fork the code
- **API-first** -- every feature available via REST API, build your own frontend or integrate with n8n/Zapier
- **Extensible** -- add new platforms (Telegram, TikTok) by implementing one TypeScript class

**Alternative to:** ManyChat, Chatfuel, ZernFlow

**For:** solopreneurs, agencies, and developers who want full control over their social media automation.

---

## Features

### Messaging
- **Auto-reply rules** -- triggers for keywords (exact, contains, starts with), comment keywords, postbacks, welcome messages, story replies/mentions, emoji reactions, and fallback/default
- **Comment automation** -- reply publicly under the comment, send a private DM (Meta `private_replies`), or both -- scoped to a specific post or all posts, on Facebook **and** Instagram
- **AI rephrasing** -- optionally rewrite any reply (including a random pool) through an OpenAI-compatible endpoint before sending
- **Live inbox** -- manage all conversations, reply manually, assign to team members
- **Drip sequences** -- timed message series with configurable delays between steps

### CRM
- **Contact management** -- full-text search, tag filtering, subscription management
- **Tags** -- organize contacts with color-coded tags
- **Conversation history** -- full message thread with sent/failed status tracking

### Platform
- **Multi-platform** -- Facebook, Instagram, YouTube, Telegram, and Gmail (two-way reply/inbox channel) live today, extensible to WhatsApp, SMS, generic email and more by implementing one TypeScript provider class
- **One-command startup** -- `docker compose up`
- **NocoDB integration** -- optional spreadsheet view of all your data (rules, contacts, messages)
- **API-first** -- 15 REST endpoints with Bearer token auth and interactive Scalar docs

### Security
- **AES-256-GCM** encryption for OAuth tokens at rest
- **Rate limiting** on auth endpoints (Postgres-backed)
- **JWT session invalidation** on logout (Postgres denylist)
- **HMAC-SHA256** webhook signature verification
- **Per-channel webhook secrets**

**Production hardening notes:**
- **Client IP / rate limiting** — the client IP is taken from the reverse proxy's `X-Real-IP` (the bundled nginx sets it and strips any client-supplied `CF-Connecting-IP`). Set `TRUSTED_PROXY=cloudflare` *only* when actually behind Cloudflare. Don't expose the app directly without a proxy that overwrites these headers.
- **CAPTCHA** — set `ALTCHA_HMAC_KEY` in production. Empty = verification skipped (dev only). Solved challenges are single-use.
- **AI rephrase** — `OPENAI_API_KEY` sends reply text to that provider; mind GDPR (use a self-hosted/DPA endpoint via `OPENAI_BASE_URL`).
- **Content Security Policy** — uses `unsafe-inline`/`unsafe-eval` because the UI runs Alpine.js + inline htmx; output is auto-escaped (`hono/html`), so CSP here is defence-in-depth, not the primary XSS control.
- **Meta `appsecret_proof`** — not sent by default. If you enable *Require app secret* in your Meta App, add it to the Graph API calls (`HMAC-SHA256(page_token, META_APP_SECRET)`).
- **Channel uniqueness** — each connected account belongs to exactly one workspace: a partial unique index allows at most one active channel per `(platform, platform_id)` instance-wide, so incoming events route to a single owner. Connecting an account already live in another workspace is refused. The migration that adds this index automatically disables any pre-existing cross-workspace duplicate (keeping the earliest-connected), so upgrades never fail.
- **First-run admin bootstrap** — registration is closed by default (`REGISTRATION_ENABLED` unset/`false`), but the **first** account on an empty instance can always register, to bootstrap the owner. This means whoever reaches `/register` first on a fresh deploy becomes the admin. Register immediately after deploying (or keep the instance network-restricted until you have), then leave `REGISTRATION_ENABLED` off so no further self-signups are possible.
- **Single-owner workspaces (no role tiers yet)** — a session/API key authorizes any action in its workspace. There is intentionally only one membership role (`owner`); richer roles (`admin`/`agent`) and per-role authorization (`requireRole()`) are deferred until member invitations exist. Until then, treat any workspace member as having full access — including destructive actions (deleting channels, erasing contacts, managing API keys).
- **Contact identity across surfaces (Meta ASID vs PSID)** — Meta gives a public *comment* an app-scoped user id and a *direct message* a page-scoped id (PSID); they are different strings with no local mapping. So the same person commenting and then DMing currently resolves to **two separate contacts**. Consequence: send limits/cooldowns aren't shared across the two, and an `unsubscribe` or GDPR erasure applies only to the identity it was performed on. Merging them requires a Graph API lookup and is planned as a dedicated feature; until then, erase/unsubscribe both identities if a contact reached you on more than one surface.
- **Contact search & non-ASCII case-folding** — the dashboard contact search uses `ILIKE`, whose case-insensitivity for non-ASCII letters (e.g. Polish `Ó`/`ó`) depends on the database locale. The bundled `postgres:alpine` initializes with the `C` locale, where `ILIKE` only case-folds ASCII — so searching `józek` won't match a stored `JÓZEK`. For correct Polish (or any non-ASCII) case-insensitive search, initialize Postgres with a UTF-8/ICU locale (e.g. set `POSTGRES_INITDB_ARGS` to use `--locale-provider=icu --icu-locale=und` on a **fresh** data volume) or add the `unaccent` extension. Keyword/automation matching is unaffected (it folds + NFC-normalizes in the app). The same `ILIKE '%term%'` search is also non-sargable (a sequential scan per keystroke); fine for small workspaces, but at scale add a `pg_trgm` GIN index on the searched columns.
- **Conversation status `snoozed`** — `snoozed` is currently a manual, permanent state (like `closed`): there is **no auto-reopen timer** (no `snoozed_until` / scheduled un-snooze), and the inbox lists conversations of all statuses, so closed/snoozed threads still appear in the list. Treat snooze as "mark resolved-for-now" rather than "remind me later". A timed snooze + status filtering/tabs in the inbox are planned.

### Telemetry & privacy

PostStack sends a small **anonymous** usage report to the maintainer once per day (and once on startup). It contains only aggregate counts (workspaces, channels, messages sent, webhooks processed, response-time aggregates…) and deployment shape (app version, runtime, OS/arch, which platforms are connected, integration on/off flags). It carries no message content, no contact data, no tokens or secrets, and no raw domain — the only identifiers are a random instance id and salted one-way hashes. Telemetry is on by default; disable it any time with `POSTSTACK_TELEMETRY_DISABLED=true`. Full detail: [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Quick Start

**Prerequisites:** Docker, Docker Compose (for local development without Docker: [Bun](https://bun.sh) + Node.js for tooling)

> **Running it for real (self-host)?** Skip straight to **[Production](#production)** below — it
> pulls the public prebuilt images (no build, no toolchain) and the **[full runbook](docs/DEPLOY.md)**
> walks you through every step (HTTPS, Meta app, admin bootstrap). The Quick Start here is for trying
> it locally / developing.

```bash
git clone https://github.com/jurczykpawel/poststack.git
cd poststack
cp .env.example .env
```

Edit `.env` -- fill in at minimum:
- `ENCRYPTION_KEY` -- any passphrase >= 32 chars, e.g. `openssl rand -base64 32`
- `JWT_SECRET` -- run `openssl rand -hex 32`
- `CRON_SECRET` -- run `openssl rand -hex 32`
- `META_APP_ID` and `META_APP_SECRET` -- from [Meta for Developers](https://developers.facebook.com)
- `META_WEBHOOK_VERIFY_TOKEN` -- any random string you choose
- `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` -- **optional**; only needed to connect an Instagram
  account via **Instagram Business Login** (and so receive Instagram DMs at Standard Access). These are
  the **Instagram** app's id/secret (Meta app → Instagram product → "API setup with Instagram login"),
  **different** from the Facebook app's `META_APP_ID`/`META_APP_SECRET`.

### Option A: Docker (recommended)

Builds and starts everything -- PostgreSQL, the Hono web server, graphile-worker:

```bash
docker compose --profile app up
```

First run takes a few minutes (builds Docker images). Open http://localhost:3000.

### Option B: Local development

Start only the databases, run the app with hot-reload:

```bash
docker compose up postgres         # database only
npm install
npm run db:migrate                 # create tables (drizzle-kit)
npm run dev                        # Hono web server (Bun, terminal 1)
npm run worker                     # graphile-worker (Bun, terminal 2)
```

Open http://localhost:3000.

---

Register an account, go to **Channels**, and connect your first Facebook Page or Instagram account.

> **Connecting Instagram — two paths.** **Instagram Business Login** (the "+ Instagram (messaging)"
> button) connects **one** Instagram account on its own — full capabilities incl. **direct messages**,
> comments, publishing and follow-gate — and needs **no Facebook page**. Alternatively, a
> **Facebook / System User** connection bulk-connects **all** your linked Instagram accounts at once,
> but only for **publishing and comments** — Instagram DMs are **not** delivered that way at Standard
> Access; add Instagram Business Login on that account to get DMs. See
> [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/META_SYSTEM_USER_SETUP.md](docs/META_SYSTEM_USER_SETUP.md).

> **Dev tunnel required for Meta webhooks.** Meta needs a public HTTPS URL to send events to.
> Run `cloudflared tunnel --url http://localhost:3000` or `npx ngrok http 3000`, then set the
> displayed URL as your webhook endpoint in the Meta App Dashboard.

### Easiest: one command with StackPilot

If you don't want to manage `.env`, secrets, and a TLS proxy by hand, deploy with
**[StackPilot](https://github.com/jurczykpawel/stackpilot)** — a self-host toolbox that installs
PostStack and **wires up Cloudflare/Caddy + HTTPS for you** (so the TLS requirement below is handled
automatically). It generates every secret (`ENCRYPTION_KEY`, `JWT_SECRET`, `CRON_SECRET`,
`ALTCHA_HMAC_KEY`, the Postgres password), brings up the full stack (nginx + web + worker +
PostgreSQL) from the public GHCR images, and runs the database migrations:

```bash
# Fully managed — app + a Cloudflare/Caddy domain with TLS, in one command:
./local/deploy.sh poststack --domain-type=cloudflare --domain=inbox.example.com

# Or, on the server itself (installs the stack with auto-generated secrets;
# then point your own reverse proxy / Cloudflare at it for HTTPS):
curl -fsSL https://stackpilot.techskills.academy/poststack | bash
```

Then open `https://inbox.example.com/register` to create the owner account and connect Meta in
**Settings** — no `.env` editing, no manual TLS. Re-running the installer preserves your existing
`.env` (so `ENCRYPTION_KEY` stays stable and stored tokens keep decrypting), and
`./local/deploy.sh poststack --update` pulls the latest image. Connect a Meta app and Google/YouTube
later from the dashboard.

Prefer to wire everything yourself? Use the manual flow below.

### Production (manual)

```bash
docker compose -f docker-compose.prod.yml up -d
```

This runs nginx (port 80) + the Hono web server + graphile-worker + PostgreSQL with **public prebuilt images** from GHCR — no build, no `docker login`, no toolchain. The `web` container runs database migrations on cold start before it serves. First start just pulls the images (a minute or two).

> **Full runbook.** See **[docs/DEPLOY.md](docs/DEPLOY.md)** for the complete step-by-step guide — standing up a new instance, updating (simple and zero-blip), rollback, backups, and troubleshooting. The notes below are the essentials.

> **⚠️ HTTPS is required.** The bundled nginx serves plain **HTTP on port 80** — Meta OAuth **and** webhooks only work over public **HTTPS**, so you must terminate TLS in front of it. Easiest options:
> - **Cloudflare** — point the (proxied/orange-cloud) DNS record at your host; Cloudflare gives free TLS at the edge and forwards to `:80`. Then set `TRUSTED_PROXY=cloudflare` in `.env` so per-IP rate limiting reads the real client IP.
> - **A TLS reverse proxy** (Caddy / Traefik / nginx with certs) in front, forwarding `https://your-domain → http://host:80`.
>
> Either way, set `APP_URL` to the public **`https://`** URL — it drives the OAuth redirect URIs and the webhook callback. Don't expose the app/nginx directly on the internet without TLS + a proxy that overwrites the client-IP headers.

> **Images & registry.** Pulls the public images `ghcr.io/jurczykpawel/poststack` and `…-worker` — no auth needed. **Pin `IMAGE_TAG`** to a released version (e.g. `v0.7.1`, not `latest`) so upgrades and rollbacks are intentional and predictable. Forks: set `IMAGE_REPO` in `.env` to your own registry path.

> **Rollback.** Pin the last good version and bring the stack back up — pinning `IMAGE_TAG` to an explicit version (not `latest`) is what makes rollbacks predictable:
> ```bash
> sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=v0.1.0/" .env   # the previous good tag
> docker compose -f docker-compose.prod.yml pull
> docker compose -f docker-compose.prod.yml up -d --no-deps --wait web worker
> ```
> Migrations are forward-only — a rollback within a release line is safe (schema compatible); rolling back across a release that dropped/renamed columns requires restoring from a backup.

### Database connection sizing

Each process opens **more than one** pg pool, so budget against the bundled Postgres' `max_connections`
(default **100**) accordingly:

- **web** = its app pool (`DB_POOL_MAX`, default 10) **+** a graphile-worker client pool used to enqueue
  jobs on webhook/connect (default ~10) → **~20 per web replica**.
- **worker** = its app pool (`DB_POOL_MAX`) **+** the graphile-worker runner pool (≈ `concurrency`, default 10)
  **+** a graphile-worker client pool used for in-job enqueue/drain re-dispatch (~10) → **~30 per worker replica**.

So roughly `web × (DB_POOL_MAX + 10) + worker × (DB_POOL_MAX + concurrency + 10)`. The single-host default
stack (1 web + 1 worker ≈ 50) sits well under 100, but scaling out adds ~20/web and ~30/worker — e.g. 4 web +
4 worker ≈ 200, which exceeds the default `max_connections`. Raise Postgres' `max_connections` before scaling
replicas, or lower `DB_POOL_MAX`. Two safety timeouts are on by default so a stalled query/transaction can't pin
a pooled connection forever: `DB_STATEMENT_TIMEOUT_MS` (30s) and `DB_IDLE_TX_TIMEOUT_MS` (60s); set either to `0` to disable.

### Backups

All state lives in Postgres (the `postgres_data` volume) — there is no other store. Back it up regularly:

```bash
# Logical dump (portable, restore with psql/pg_restore)
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > replystack-$(date +%F).sql.gz
```

Or snapshot the `postgres_data` volume at the filesystem level while the stack is stopped. Test a restore
before you need one.

### Rotating `ENCRYPTION_KEY`

Channel OAuth tokens are encrypted at rest with `ENCRYPTION_KEY`. **Swapping the key without
re-encrypting first makes every channel undecryptable** — decryption throws, so all sends and refreshes fail
and every channel must be reconnected. To rotate safely: with the **old** key still in place, decrypt and
re-encrypt every `channels.token_encrypted` under the new key (in a maintenance step that holds both keys),
**then** swap `ENCRYPTION_KEY` to the new value and restart. Always take a backup (above) first.

---

## Meta App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new App (Business type).
2. Copy the **App ID** and **App Secret** into `META_APP_ID` / `META_APP_SECRET` in your `.env` (or set them in Settings → Meta App after first login).
3. Add the **Facebook Login** product and, under its settings, add these to **Valid OAuth Redirect URIs** (replace with your real `APP_URL`) — without them the dashboard's **Connect channel** flow is rejected by Meta:
   - `https://your-domain.com/api/oauth/facebook/callback`
   - `https://your-domain.com/api/oauth/instagram/callback`
4. Add the **Messenger** and **Instagram** products.
5. In **Webhooks**, set the callback URL to `https://your-domain.com/api/webhooks/meta` and the verify token to match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`, then subscribe to: `messages`, `messaging_postbacks`, `feed` (PostStack auto-subscribes each connected Page to the fields it needs; check **Webhooks → Subscriptions** in the dashboard for active-vs-expected status).

**Note:** your `APP_URL` must be public **HTTPS** (see [Production → HTTPS](#production)) — Meta rejects `http://` and `localhost` for OAuth redirects and webhooks. For local testing, expose your dev server with a tunnel (`cloudflared tunnel --url http://localhost:3000` or `npx ngrok http 3000`) and use that HTTPS URL. Some permissions require Meta App Review for production; in development mode you can test with your own accounts without review.

> **One-token setup (recommended for self-host):** instead of connecting Pages one by one, paste a
> single permanent Meta **System User** token and PostStack auto-connects every Page + linked
> Instagram account it can reach, and keeps them in sync. Full guide:
> **[docs/META_SYSTEM_USER_SETUP.md](docs/META_SYSTEM_USER_SETUP.md)**.

---

## Meta Access Levels — what needs App Review (and what doesn't)

**Short answer:** if you self-host and only operate **your own** Facebook Pages / Instagram
accounts, you do **not** need Meta App Review or Business Verification. Every PostStack feature
works under **Standard Access**, which every app has by default. App Review only becomes relevant
when you start operating accounts that belong to **other people** (a multi-client / agency setup).

### Why — Meta's two access tiers

Meta gates every permission behind one of two tiers:

| Tier | What it grants | Requires |
|---|---|---|
| **Standard Access** (default, every app) | The permission works for any user who has a **role on your app** (Admin / Developer / Tester) and for the Pages / IG accounts those users manage. | Nothing — no review. |
| **Advanced Access** | The same permission, but usable with users who do **NOT** have a role on your app — i.e. the general public / other people's accounts. | **App Review** + **Business Verification**. |

When you create your own Meta app you are automatically its **Admin**, and the Pages / IG accounts
you connect are ones you manage. So every permission PostStack requests resolves at **Standard
Access** — no review needed. That is why all the inbox / auto-reply / comment features work on your
own accounts **without App Review**.

> **One caveat about app *mode* (distinct from review):** to receive **real** webhook events
> (incoming DMs, comments) — even for your own Pages — the Meta app must be switched to **Live**
> mode. In **Development** mode Meta delivers only *test* webhooks fired from the App Dashboard, and
> **no production data is delivered, not even for admins/developers/testers**. Switching to Live is a
> one-time toggle (it just needs a Privacy Policy URL set on the app) and is **not** the same as App
> Review — **Live mode ≠ Advanced Access**. So for your own accounts: flip the app to **Live**, but
> you still do **not** need App Review.

> **The line you cross:** the moment you want to handle a Page or IG account that someone *else*
> administers (a client, a customer) and that person is not added as a Tester on your app, that
> account is "a user without a role on your app" → you need **Advanced Access** for the relevant
> permissions, which means App Review + Business Verification. This is exactly what a managed /
> reseller offering (the "connect under one verified app" model) requires.

### Per-feature map (the permissions PostStack actually requests)

PostStack requests only these scopes — Facebook: `pages_show_list`, `pages_messaging`,
`pages_read_engagement`, `pages_manage_metadata`; Instagram additionally: `instagram_basic`,
`instagram_manage_messages`, `instagram_manage_comments`.

| Feature | Permission(s) | Your own accounts (Standard Access, app in **Live** mode) | Other people's accounts |
|---|---|---|---|
| List & connect your Pages / IG | `pages_show_list` | ✅ works | needs Advanced Access |
| Receive DMs in the inbox (FB Messenger) | `pages_messaging` | ✅ works | needs Advanced Access |
| Receive DMs in the inbox (Instagram) | `instagram_basic`, `instagram_manage_messages` | ✅ works | needs Advanced Access |
| Send replies / auto-replies (FB + IG DM) | `pages_messaging` / `instagram_manage_messages` | ✅ works | needs Advanced Access |
| Read post comments | `pages_read_engagement` (FB) / `instagram_manage_comments` (IG) | ✅ works | needs Advanced Access |
| Comment → DM (private reply) | `pages_messaging` (FB) / `instagram_manage_messages` (IG) | ✅ works | needs Advanced Access |
| Manage Page webhook subscriptions | `pages_manage_metadata` | ✅ works | needs Advanced Access |
| Read receipts, echoes, delivery receipts in the thread | `pages_messaging` | ✅ works | needs Advanced Access |
| **Emoji reactions on your DMs** (the `message_reactions` webhook) | `pages_messaging` | ⚠️ **requires Advanced Access to be delivered** — this one Engagement signal does not fire under Standard Access, even on your own account | needs Advanced Access |

So the **only** own-account limitation is that the *emoji-reaction* webhook (`message_reactions`)
won't be delivered until the app has Advanced Access on `pages_messaging`. Everything else — inbox,
auto-replies, comment automation, sequences, read/delivery receipts — works fully on your own
accounts with no review.

### What App Review does **not** change

- **Token longevity** is independent of review — see the System User guidance below / managed
  connection docs. Review does not make tokens last longer.
- **Messaging policy windows** (e.g. Meta's standard messaging window after a user's last message)
  apply regardless of access tier.
- Switching the app to **Live mode** without Advanced Access does **not** grant access to other
  people's accounts — only App Review does.

### Checklist: do you need App Review?

- Self-hosting for **your own** brand's Pages/IG → **No App Review.** (But do switch the app to
  **Live** mode so production webhooks are delivered — that's a toggle, not a review. Optional:
  request Advanced Access on `pages_messaging` only if you want emoji-reaction webhooks.)
- Managing a **client's** account where you add them as a **Tester** on your app and they accept →
  **No** (they now have a role on your app).
- Offering this as a **service to customers** who connect their own accounts under your app →
  **Yes** — App Review + Business Verification for the permissions above.

### Other channels — same story

This isn't unique to Meta. **None of PostStack's currently-supported channels require a lengthy
review or identity/business verification to run on your own accounts** — only the normal,
self-service developer-app configuration:

- **Telegram** — literally just a **bot token** from [@BotFather](https://t.me/BotFather). No app, no review, nothing else.
- **Facebook / Instagram** — your own Pages/IG under **Standard Access** (above); just create the app and switch it to **Live**.
- **Gmail / YouTube (Google)** — your own (or test-user) account works **without verification**; set the OAuth consent screen to **In production** so refresh tokens are long-lived. Google's full **verification + CASA** review is only needed to serve **external** mailboxes/channels at scale (beyond ~100 users / sensitive scopes) — i.e. the same "other people's accounts" line as Meta.

In short: **deploy, configure your own developer app, connect your accounts — no weeks-long approval gate.**

---

## Gmail Setup

To enable Gmail mailbox support, create a Google Cloud OAuth app:

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a new project.
2. Enable the **Gmail API** in your project (APIs & Services → Library → search "Gmail").
3. Create an OAuth 2.0 Client ID (APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID):
   - **Application type:** Web application
   - **Authorized redirect URIs:** add `https://your-domain.com/api/oauth/gmail/callback` (use your real `APP_URL`)
4. Copy the **Client ID** and **Client Secret** into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in your `.env` (or set them in Settings → OAuth after first login).
5. **OAuth scope:** PostStack requests `openid`, `email`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.send` — read-only ingest and send.

**Verification note:** Google restricts these scopes. An **unverified app** can only authorize the developer's own Gmail account + ~100 test users. To **serve external mailboxes** (real multi-tenant usage), your Google app must pass **OAuth verification** and **Google's CASA security assessment** (annual; separate fee). For **self-hosting your own team's Gmail**, add your account as a test user — no assessment needed.

> **Publishing status matters (the Google equivalent of Meta's Live mode):** while the OAuth consent
> screen is left in **Testing**, Google **expires refresh tokens after 7 days** — so the channel
> silently stops working a week after you connect it. Set the consent screen's publishing status to
> **In production** (Production) to get long-lived refresh tokens. Production *without* full
> verification still works for your own/test-user accounts (with the unverified-app warning, capped
> at ~100 users); verification + CASA is only needed to lift that cap for external mailboxes.

**Optional:** each Gmail channel can use an ingest filter (e.g. `label:support`, `is:unread`, `-category:promotions`) to narrow the messages PostStack polls. Set it in the dashboard or via the API when connecting the channel.

The same Google app can also serve **YouTube** (`youtube` platform) — just add the YouTube channel to the app and use the same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

---

## TikTok publishing

TikTok is supported as a **publishing** channel, with one important limitation to be aware of today.

TikTok only allows **direct, fully-automated publishing** for apps that have passed its
**content-posting audit**. Until an app is audited, TikTok's Content Posting API is restricted to the
**inbox / draft** flow: PostStack uploads your video to your TikTok **inbox as a draft**, and you open
the TikTok app to set the caption, cover and privacy and tap publish. Unaudited apps are also capped
to **private (`SELF_ONLY`)** visibility. So scheduling a TikTok post lands a ready-to-confirm draft in
your inbox — it is **not** a hands-off auto-publish, and **full automation isn't possible yet**.

We're working hard to remove this friction — either by offering our own **audited app** you can
publish through, or by making the approval process dramatically easier. That's the goal of a dedicated
companion project, **[ShareStack](https://sharestack.techskills.academy/)** — a free, browser-first,
self-hostable publisher that keeps your OAuth token in your own browser. Until that lands, treat
TikTok publishing as **draft-only**.

The other publishing channels — **X, LinkedIn, Threads, YouTube, Facebook & Instagram** — publish
directly, subject to each platform's own developer-app setup and API access tier.

---

## Usage

### 1. Connect a channel

Go to **Channels** and click **+ Facebook** or **+ Instagram**. You'll be redirected to Meta to authorize access. After granting permissions, your Pages/IG accounts appear in the list.

### 2. Set up auto-reply rules

Go to **Rules** and click **+ New Rule**:

- **Name** -- e.g. "Welcome keyword"
- **Trigger** -- choose "Keyword (DM)", enter keywords like `hello, hi, start`
- **Match type** -- "Contains", "Exact", or "Starts with"
- **Reply text** -- the message to send back automatically
- **Priority** -- higher = checked first (rules are evaluated top to bottom)
- **Cooldown** -- minimum seconds between fires for the same contact

For comment automation, use "Keyword (Comment)" trigger -- when someone comments a keyword on your post, PostStack sends them a DM.

### 3. View conversations

Go to **Inbox** to see all incoming conversations. Click a conversation to view the message thread. Type a reply and press Enter to send manually.

You can:
- **Mark as read** -- click a conversation to reset unread count
- **Close** -- mark conversation as resolved
- **Pause automation** -- stop auto-replies for a specific conversation

### 4. Create drip sequences

Go to **Sequences** and click **+ New Sequence**. Add steps:

- **Message** -- text to send
- **Delay** -- wait N minutes before the next step

Activate the sequence, then enroll contacts via the API:

```bash
curl -X POST https://your-domain.com/api/v1/sequences/{id}/enroll \
  -H "Authorization: Bearer sk_live_your-key" \
  -H "Content-Type: application/json" \
  -d '{"contact_id": "...", "channel_id": "..."}'
```

### 5. API access

Go to **Settings** and create an API key. Use it with any HTTP client:

```bash
# List contacts
curl https://your-domain.com/api/v1/contacts \
  -H "Authorization: Bearer sk_live_your-key"

# Send a manual reply
curl -X POST https://your-domain.com/api/v1/conversations/{id}/messages \
  -H "Authorization: Bearer sk_live_your-key" \
  -H "Content-Type: application/json" \
  -d '{"text": "Thanks for reaching out!"}'
```

Interactive docs at `/api/docs` (Scalar UI).

---

## Architecture

```
replystack/
├── src/
│   ├── server/                  # Hono app (web process)
│   │   ├── app.ts               #   factory: security headers, CORS, route mounting
│   │   ├── index.ts             #   entrypoint
│   │   ├── routes/              #   public / v1 / oauth / webhooks / pages routers
│   │   ├── handlers/            #   framework-neutral HTTP handlers (routes delegate here)
│   │   ├── ui/                  #   hono/html SSR templates + CSS (htmx + Alpine)
│   │   └── middleware/          #   security headers, page auth
│   ├── lib/
│   │   ├── platforms/           #   SocialProvider base + Facebook, Instagram
│   │   ├── rules/               #   matcher + executor (keyword, comment, story, reaction, ...)
│   │   ├── workers/             #   graphile-worker job processors
│   │   ├── queue/               #   graphile-worker client (addJob + task list)
│   │   ├── auth/                #   JWT sessions, API keys, password hashing
│   │   ├── api/                 #   response helpers, rate limiter, OpenAPI spec
│   │   ├── oauth/               #   OAuth flow helpers
│   │   ├── channels/            #   channel connect / upsert
│   │   ├── notifications/       #   channel-failure alerts (outbound webhook)
│   │   ├── ai/                  #   AI rephrase adapter (optional)
│   │   └── crypto.ts            #   token encryption (AES-256-GCM)
│   ├── db/                      # Drizzle schema + relations
│   └── types/                   # shared types
├── worker/                      # standalone graphile-worker process (inbox-worker.ts)
├── drizzle/                     # generated SQL migrations (drizzle-kit)
└── docker/                      # Dockerfile, Dockerfile.worker, nginx.conf
```

```
Web (Hono on Bun)                Worker (graphile-worker on Bun)
─────────────────                ───────────────────────────────
POST /api/webhooks/meta    ──>   incoming-message    ──> contact upsert
                                                     ──> rule engine ──> outgoing-message
GET/POST /api/v1/*               incoming-comment    ──> comment log + rule eval
GET /api/oauth/*                                     ──> outgoing-comment / outgoing-private-reply
GET /api/cron/token-refresh      incoming-reaction   ──> reaction rule eval
                                 outgoing-*           ──> Meta Graph API send
                                 token-refresh        ──> refresh expiring OAuth tokens
                                 sequence-steps       ──> drip campaign delivery
```

---

## API

PostStack is API-first. Every feature in the dashboard is available via REST API.

**Docs:** `GET /api/docs` -- interactive Scalar UI

**Auth:** `Authorization: Bearer sk_live_<key>` (generate in Settings > API Keys)

| Endpoint | Methods | Description |
|----------|---------|-------------|
| `/api/v1/channels` | GET | List connected channels |
| `/api/v1/channels/:id` | GET, PATCH, DELETE | Channel detail, rename, disconnect |
| `/api/v1/conversations` | GET | List conversations (cursor-paginated) |
| `/api/v1/conversations/:id` | GET, PATCH | Detail, mark read, close, pause automation |
| `/api/v1/conversations/:id/messages` | GET, POST | Message history + send reply |
| `/api/v1/rules` | GET, POST | List and create auto-reply rules |
| `/api/v1/rules/:id` | GET, PATCH, DELETE | Rule detail, update, delete |
| `/api/v1/sequences` | GET, POST | List and create drip sequences |
| `/api/v1/sequences/:id` | GET, PATCH, DELETE | Sequence detail, update status, delete |
| `/api/v1/sequences/:id/enroll` | POST | Enroll a contact in a sequence |
| `/api/v1/contacts` | GET | List contacts (search, tag filter, cursor-paginated) |
| `/api/v1/contacts/:id` | GET, PATCH | Contact detail, update name/email |
| `/api/v1/tags` | GET, POST | List and create tags |
| `/api/v1/api-keys` | GET, POST | List and create API keys |
| `/api/v1/api-keys/:id` | DELETE | Revoke an API key |

```bash
curl https://your-domain.com/api/v1/contacts \
  -H "Authorization: Bearer sk_live_your-key-here"
```

All responses follow the shape `{ data, error, meta? }`.

### Migrating from another tool

Coming from Buffer, Hootsuite, Later, Publer, SocialBee, or ManyChat? See
[docs/migration](docs/migration/README.md) for step-by-step guides and a reference import script — bring
your scheduled posts, subscribers, and tags into your own instance, no per-contact fees.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Hono (web server + API) |
| UI | Server-rendered HTML + htmx + Alpine.js (no client framework) |
| Database | PostgreSQL + Drizzle ORM |
| Queue | PostgreSQL (graphile-worker) |
| Auth | JWT (jose) + API keys |
| Encryption | AES-256-GCM (tokens at rest) |
| Runtime | Bun |
| Infra | Docker Compose |

---

## NocoDB (Optional)

NocoDB connects to the same PostgreSQL database and gives you a spreadsheet view of all your data -- useful for editing rules in bulk, browsing contacts, or monitoring sequences.

```bash
docker compose --profile nocodb up
```

Open http://localhost:8080

For security, create a read-only PostgreSQL role for NocoDB:

```sql
CREATE ROLE nocodb_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE replystack TO nocodb_readonly;
GRANT USAGE ON SCHEMA public TO nocodb_readonly;
GRANT SELECT ON contacts, contact_tags, tags, conversations, messages,
                auto_reply_rules, sequences, sequence_enrollments,
                comment_logs TO nocodb_readonly;
```

Then update `NC_DB` in `docker-compose.yml` to use this role.

---

## Development

See [Quick Start - Option B](#option-b-local-development) for setup. Additional commands:

```bash
npm run lint              # ESLint
npm run typecheck         # TypeScript (tsc --noEmit; Bun runs the TS entrypoint directly, no build artifact)
npm test                  # Vitest unit
npm run test:integration  # Vitest integration (needs a Postgres; set TEST_DATABASE_URL)
```

---

## Roadmap

- [x] Project skeleton, auth, Docker Compose
- [x] OAuth channels (Facebook + Instagram)
- [x] Meta webhook receiver (HMAC verified)
- [x] Inbox -- conversation list, message thread, manual reply
- [x] graphile-worker job processors (incoming/outgoing messages, comments, reactions, token refresh, sequences)
- [x] Rule engine -- keyword auto-reply with cooldown
- [x] Comment automation -- public reply + private DM (first-touch), Facebook & Instagram
- [x] Story reply/mention and emoji reaction triggers
- [x] Optional AI rephrasing of replies (OpenAI-compatible)
- [x] Drip sequences with delays
- [x] Contacts CRM with tags and search
- [x] API key management + token refresh
- [x] Rate limiting, JWT invalidation, outgoing message idempotency (all Postgres-backed, no Redis)
- [x] CI/CD (lint, typecheck, test, Docker build + push)
- [x] Gmail support (Google OAuth2, Gmail API, cron polling, per-mailbox ingest filter)
- [x] Telegram support
- [ ] Discord support (Bot API, Gateway WebSocket)
- [ ] Visual flow builder (v2)
- [ ] Broadcast campaigns
- [ ] Webhook events (outbound notifications)
- [ ] Multi-workspace team management

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Adding a Platform

1. Create `src/lib/platforms/{platform}.ts` extending `SocialProvider`
2. Register it in `src/lib/platforms/registry.ts`
3. Add an OAuth callback route at `src/server/handlers/oauth/{platform}/`
4. Add the platform to the `platform` enum in `src/db/schema.ts`

### Development workflow

```bash
git checkout -b feat/your-feature
# make changes
npm run typecheck && npm test
git commit -m "feat: your feature"
```

---

## License

[Elastic License 2.0](LICENSE) — source-available.

You're free to self-host, use, modify, and redistribute PostStack. The only limits: you may **not** offer it to third parties as a hosted/managed service, and you may **not** circumvent the license-key functionality. Self-hosting it for your own business is always free. For a commercial/managed-service license, get in touch.

---

## Acknowledgments

Built with inspiration from:
- [Postiz](https://github.com/gitroomhq/postiz-app) -- OAuth provider pattern
- [ZernFlow](https://github.com/zernio-dev/zernflow) -- flow engine concepts (UI inspiration for v2)
- The n8n automation workflows that powered the original system
