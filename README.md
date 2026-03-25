# ReplyStack

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![CI](https://github.com/jurczykpawel/replystack/actions/workflows/ci.yml/badge.svg)](https://github.com/jurczykpawel/replystack/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Self-hosted social media inbox automation. Connect your Facebook and Instagram accounts, define keyword rules, auto-reply to messages and comments, manage conversations from one inbox.

Open-source alternative to ManyChat. No platform fees, no vendor lock-in.

---

## Features

- **Auto-reply rules** -- keyword triggers (exact, contains, starts with), postbacks, welcome messages, fallback/default
- **Comment-to-DM** -- automatically DM users who comment specific keywords on your posts
- **Live inbox** -- manage all conversations, reply manually, assign to team members
- **Drip sequences** -- timed message series with configurable delays
- **Contact CRM** -- tags, search, subscription management
- **Multi-platform** -- Facebook and Instagram on launch, extensible to Telegram, TikTok, and more
- **API-first** -- every feature available via REST API with Bearer token auth
- **NocoDB integration** -- optional spreadsheet view of all your data (rules, contacts, messages)
- **One-command startup** -- `docker compose up`

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

```bash
docker compose up
```

Open http://localhost:3000, register an account, and connect your first channel.

> **Dev tunnel required for Meta webhooks.** Meta needs a public HTTPS URL to send events to.
> Run `cloudflared tunnel --url http://localhost:3000` or `npx ngrok http 3000`, then set the
> displayed URL as your webhook endpoint in the Meta App Dashboard.

## Meta App Setup

1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new App (Business type)
2. Add **Messenger** and **Instagram** products
3. In Webhooks, set the callback URL to `https://your-domain.com/api/webhooks/meta`
4. Set the verify token to match `META_WEBHOOK_VERIFY_TOKEN` in your `.env`
5. Subscribe to: `messages`, `messaging_postbacks`, `feed`

**Note:** Some permissions require Meta App Review for production use. In development mode, you can test with your own accounts without review.

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

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Database | PostgreSQL + Prisma |
| Queue | Redis + BullMQ |
| Auth | JWT (jose) + API keys |
| Encryption | AES-256-GCM (tokens at rest) |
| Runtime | Node.js 18+ |

## Development

```bash
docker compose up postgres redis
npm install
npm run db:migrate
npm run dev       # Next.js dev server
npm run worker    # BullMQ worker (separate terminal)
```

```bash
npm run typecheck   # TypeScript
npm test            # Vitest
```

## Adding a Platform

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. In short:

1. Create `src/lib/platforms/{platform}.ts` extending `SocialProvider`
2. Register it in `src/lib/platforms/registry.ts`
3. Add an OAuth callback route at `src/app/api/oauth/{platform}/`
4. Add the platform to the `Platform` enum in `prisma/schema.prisma`

## License

[AGPL-3.0](LICENSE)

If you modify ReplyStack and offer it as a service, AGPL requires you to publish your modifications under the same license.
