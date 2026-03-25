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
- **Auto-reply rules** -- keyword triggers (exact, contains, starts with), postbacks, welcome messages, fallback/default
- **Comment-to-DM** -- automatically DM users who comment specific keywords on your posts
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
- **Rate limiting** on auth endpoints (Redis-backed)
- **JWT session invalidation** on logout (Redis denylist)
- **HMAC-SHA256** webhook signature verification
- **Per-channel webhook secrets**

---

## Quick Start

**Prerequisites:** Docker, Docker Compose

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

Builds and starts everything -- PostgreSQL, Redis, Next.js web, BullMQ worker:

```bash
docker compose --profile app up
```

First run takes a few minutes (builds Docker images). Open http://localhost:3000.

### Option B: Local development

Start only the databases, run the app with hot-reload:

```bash
docker compose up postgres redis   # databases only
npm install
npx prisma migrate deploy          # create tables
npm run dev                        # Next.js (terminal 1)
npm run worker                     # BullMQ worker (terminal 2)
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

This runs nginx (port 80) + Next.js web + BullMQ worker + PostgreSQL + Redis with pre-built images.

---

## Meta App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new App (Business type)
2. Add **Messenger** and **Instagram** products
3. In Webhooks, set the callback URL to `https://your-domain.com/api/webhooks/meta`
4. Set the verify token to match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`
5. Subscribe to: `messages`, `messaging_postbacks`, `feed`

**Note:** Some permissions require Meta App Review for production use. In development mode, you can test with your own accounts without review.

---

## Architecture

```
replystack/
├── src/
│   ├── app/
│   │   ├── (auth)/              # Login, register pages
│   │   ├── (dashboard)/         # Inbox, rules, channels, contacts, sequences, settings
│   │   └── api/
│   │       ├── auth/            # Login, register, logout
│   │       ├── oauth/           # Facebook + Instagram OAuth flows
│   │       ├── webhooks/meta/   # Meta webhook receiver (HMAC verified)
│   │       ├── cron/            # Token refresh scheduler
│   │       └── v1/              # REST API (channels, conversations, rules, etc.)
│   └── lib/
│       ├── platforms/           # SocialProvider base + Facebook, Instagram
│       ├── rules/               # Matcher + executor (keyword, comment, welcome, default)
│       ├── workers/             # BullMQ job processors
│       ├── auth/                # JWT sessions, API keys, password hashing
│       ├── api/                 # Response helpers, rate limiter, body parser
│       └── queue/               # BullMQ queue definitions
├── worker/                      # Standalone BullMQ worker process
├── prisma/                      # Database schema (15 models)
└── docker/                      # Dockerfile, Dockerfile.worker, nginx.conf
```

```
Web (Next.js)                    Worker (BullMQ)
─────────────                    ───────────────
POST /api/webhooks/meta    ──>   incoming-messages  ──> contact upsert
                                                    ──> rule engine ──> outgoing-messages
GET/POST /api/v1/*               incoming-comments  ──> comment log + rule eval
GET /api/oauth/*                 outgoing-messages   ──> Meta Graph API send
                                 token-refresh       ──> refresh expiring OAuth tokens
                                 sequence-steps      ──> drip campaign delivery
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
| Framework | Next.js 15 (App Router) |
| Database | PostgreSQL + Prisma 6 |
| Queue | Redis + BullMQ |
| Auth | JWT (jose) + API keys |
| Encryption | AES-256-GCM (tokens at rest) |
| Runtime | Node.js 18+ |
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
npm run lint        # ESLint
npm run typecheck   # TypeScript
npm test            # Vitest (23 tests)
npm run build       # Production build
```

---

## Roadmap

- [x] Project skeleton, auth, Docker Compose
- [x] OAuth channels (Facebook + Instagram)
- [x] Meta webhook receiver (HMAC verified)
- [x] Inbox -- conversation list, message thread, manual reply
- [x] BullMQ workers (incoming messages, outgoing messages, comments)
- [x] Rule engine -- keyword auto-reply with cooldown
- [x] Comment-to-DM automation
- [x] Drip sequences with delays
- [x] Contacts CRM with tags and search
- [x] API key management + token refresh
- [x] Rate limiting, JWT invalidation, outgoing message idempotency
- [x] CI/CD (lint, typecheck, test, build, Docker)
- [ ] Visual flow builder (v2)
- [ ] Telegram support
- [ ] Broadcast campaigns
- [ ] Webhook events (outbound notifications)
- [ ] Multi-workspace team management

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Adding a Platform

1. Create `src/lib/platforms/{platform}.ts` extending `SocialProvider`
2. Register it in `src/lib/platforms/registry.ts`
3. Add an OAuth callback route at `src/app/api/oauth/{platform}/`
4. Add the platform to the `Platform` enum in `prisma/schema.prisma`

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
