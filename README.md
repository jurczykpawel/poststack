# ReplyStack

> Self-hosted Meta inbox automation -- auto-reply to messages and comments, manage conversations from one inbox.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![CI](https://github.com/jurczykpawel/replystack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/replystack/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Open Source](https://img.shields.io/badge/Open%20Source-100%25-brightgreen)](https://github.com/jurczykpawel/replystack)

[API Docs](/api/docs) | [Issues](https://github.com/jurczykpawel/replystack/issues) | [Contributing](CONTRIBUTING.md)

---

## Why ReplyStack?

- **Self-hosted** -- your data stays on your server, not on someone else's SaaS
- **No platform fees** -- ManyChat charges $15-65/mo per account. ReplyStack is free forever
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
- **Multi-platform** -- Facebook Pages and Instagram Business on launch, extensible to Telegram, TikTok, and more
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
- **Contact search & non-ASCII case-folding** — the dashboard contact search uses `ILIKE`, whose case-insensitivity for non-ASCII letters (e.g. Polish `Ó`/`ó`) depends on the database locale. The bundled `postgres:alpine` initializes with the `C` locale, where `ILIKE` only case-folds ASCII — so searching `józek` won't match a stored `JÓZEK`. For correct Polish (or any non-ASCII) case-insensitive search, initialize Postgres with a UTF-8/ICU locale (e.g. set `POSTGRES_INITDB_ARGS` to use `--locale-provider=icu --icu-locale=und` on a **fresh** data volume) or add the `unaccent` extension. Keyword/automation matching is unaffected (it folds + NFC-normalizes in the app).

---

## Quick Start

**Prerequisites:** Docker, Docker Compose (for local development without Docker: [Bun](https://bun.sh) + Node.js for tooling)

```bash
git clone https://github.com/jurczykpawel/replystack.git
cd replystack
cp .env.example .env
```

Edit `.env` -- fill in at minimum:
- `TOKEN_ENCRYPTION_KEY` -- run `openssl rand -hex 32`
- `JWT_SECRET` -- run `openssl rand -hex 32`
- `CRON_SECRET` -- run `openssl rand -hex 32`
- `META_APP_ID` and `META_APP_SECRET` -- from [Meta for Developers](https://developers.facebook.com)
- `META_WEBHOOK_VERIFY_TOKEN` -- any random string you choose

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

> **Dev tunnel required for Meta webhooks.** Meta needs a public HTTPS URL to send events to.
> Run `cloudflared tunnel --url http://localhost:3000` or `npx ngrok http 3000`, then set the
> displayed URL as your webhook endpoint in the Meta App Dashboard.

### Production

```bash
docker compose -f docker-compose.prod.yml up -d
```

This runs nginx (port 80) + the Hono web server + graphile-worker + PostgreSQL with pre-built images from GHCR.

> **Images & registry.** By default it pulls `ghcr.io/jurczykpawel/replystack` (and `-worker`). If the packages are private, run `docker login ghcr.io` first. Forks: set `IMAGE_REPO` in `.env` to your own registry path, and `IMAGE_TAG` to pin a version.

---

## Meta App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new App (Business type)
2. Add **Messenger** and **Instagram** products
3. In Webhooks, set the callback URL to `https://your-domain.com/api/webhooks/meta`
4. Set the verify token to match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`
5. Subscribe to: `messages`, `messaging_postbacks`, `feed`

**Note:** Some permissions require Meta App Review for production use. In development mode, you can test with your own accounts without review.

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

For comment automation, use "Keyword (Comment)" trigger -- when someone comments a keyword on your post, ReplyStack sends them a DM.

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
  -H "Authorization: Bearer rs_live_your-key" \
  -H "Content-Type: application/json" \
  -d '{"contact_id": "...", "channel_id": "..."}'
```

### 5. API access

Go to **Settings** and create an API key. Use it with any HTTP client:

```bash
# List contacts
curl https://your-domain.com/api/v1/contacts \
  -H "Authorization: Bearer rs_live_your-key"

# Send a manual reply
curl -X POST https://your-domain.com/api/v1/conversations/{id}/messages \
  -H "Authorization: Bearer rs_live_your-key" \
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

ReplyStack is API-first. Every feature in the dashboard is available via REST API.

**Docs:** `GET /api/docs` -- interactive Scalar UI

**Auth:** `Authorization: Bearer rs_live_<key>` (generate in Settings > API Keys)

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
  -H "Authorization: Bearer rs_live_your-key-here"
```

All responses follow the shape `{ data, error, meta? }`.

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
npm test                  # Vitest unit (212 tests)
npm run test:integration  # Vitest integration (127 tests, needs a Postgres on :5433)
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
- [ ] Gmail support (Google OAuth2, Gmail API, Pub/Sub push)
- [ ] Discord support (Bot API, Gateway WebSocket)
- [ ] Telegram support
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

[AGPL-3.0](LICENSE)

If you modify ReplyStack and offer it as a service, AGPL requires you to publish your modifications under the same license.

---

## Acknowledgments

Built with inspiration from:
- [Postiz](https://github.com/gitroomhq/postiz-app) -- OAuth provider pattern
- [ZernFlow](https://github.com/zernio-dev/zernflow) -- flow engine concepts (UI inspiration for v2)
- The n8n automation workflows that powered the original system
