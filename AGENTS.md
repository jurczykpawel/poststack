# AGENTS.md - ReplyStack

## Project Overview

**ReplyStack** — self-hosted, open-source Meta (Facebook + Instagram) inbox automation platform.
AGPL-3.0. One-command startup via Docker Compose.

Alternative to ManyChat / ZernFlow, without vendor lock-in.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript 5 |
| Database | PostgreSQL + Prisma |
| Cache / Queue | Redis + BullMQ |
| Styling | Tailwind CSS 4 + shadcn/ui |
| Platforms | Facebook, Instagram (extensible via provider pattern) |
| Auth | Custom JWT (jose) |
| Encryption | AES-256-GCM (Node.js crypto) |
| Infra | Docker Compose |

## Architecture

```
Web process (Next.js):
  - /api/webhooks/meta/[channelId]  → enqueue jobs
  - /api/oauth/facebook|instagram   → OAuth callbacks
  - /api/cron/sequences             → drip campaign steps
  - /dashboard/*                    → admin UI

Worker process (BullMQ):
  - incoming-messages worker  → contact upsert → rule engine → enqueue reply
  - outgoing-messages worker  → Meta Graph API send
  - token-refresh worker      → refresh expiring OAuth tokens
  - sequence-steps worker     → deliver drip sequence messages
```

## API-First Design

ReplyStack is API-first. All features exposed via REST at `/api/v1/*`.

- **Dual auth:** session JWT cookie (dashboard) + `Authorization: Bearer rs_live_<key>` (external)
- **CORS:** enabled on all `/api/v1/*` routes
- **OpenAPI spec:** `src/lib/api/openapi.ts` — update when adding new routes
- **Scalar UI:** `/api/docs` (no npm dep, CDN-loaded)
- **Response shape:** always `{ data, error, meta? }` — use helpers from `src/lib/api/response.ts`
- **Auth helper:** `authenticate(request)` from `src/lib/auth/index.ts` — handles both auth methods

## Key Directories

```
src/
├── app/                  # Next.js App Router (auth, dashboard, API routes)
├── lib/
│   ├── platforms/        # SocialProvider base class + FB/IG implementations
│   ├── rule-engine/      # matcher.ts + executor.ts
│   ├── flow-engine/      # v2 placeholder (same shape as ZernFlow engine.ts)
│   ├── queue/            # BullMQ client (queue definitions)
│   ├── workers/          # Worker implementations
│   ├── crypto.ts         # Token encryption/decryption
│   ├── prisma.ts         # PrismaClient singleton
│   └── redis.ts          # IORedis singleton
├── components/           # React components (inbox, rules, channels, ui)
worker/
└── inbox-worker.ts       # BullMQ worker entrypoint (separate process)
prisma/
└── schema.prisma         # Full schema (contacts, channels, rules, flows, sequences)
docker/
├── Dockerfile
├── Dockerfile.worker
└── nginx.conf
```

## Reference Implementations

- **Flow engine:** `repos/zernflow/lib/flow-engine/engine.ts` — port to Prisma for v2
- **Trigger matching:** `repos/zernflow/lib/flow-engine/trigger-matcher.ts` — direct reference for `rule-engine/matcher.ts`
- **Worker pattern:** `projects/reelstack/apps/web/worker/reel-worker.ts` — BullMQ entrypoint
- **Platform adapter:** `repos/zernflow/lib/flow-engine/platform-adapter.ts`
- **n8n reference:** `n8n.qreative.pl` workflows (IDs: ZNfDQ8JIB4ot3YQh, bj45gBZk0fSFLRdb, 3MG7b5Ye1TQzm7BE, 1dvQ9WJRhu0xoz0V, FsJvaHih3BLuu5ry, yZZCDd8UaPQfiBPs, CWvQUI2Kqz5Nd82P)

## Development

```bash
# Start dependencies
docker compose up postgres redis nocodb

# Install + migrate
bun install
bun run db:migrate

# Run web (terminal 1)
bun dev

# Run worker (terminal 2)
bun run worker
```

## Environment Variables

See `.env.example`. Required:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection (with password) |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex (`openssl rand -hex 32`) |
| `JWT_SECRET` | Auth JWT secret |
| `META_APP_ID` | Facebook App ID |
| `META_APP_SECRET` | Facebook App Secret |
| `NEXT_PUBLIC_APP_URL` | Public URL (for OAuth redirect + webhook URL display) |

## Important Rules

- **ALWAYS read `vault/brands/_shared/reference/coding-standards.md` before writing code**
- **Security:** See `vault/brands/_shared/prompts/checklists/security.md`
- **OAuth tokens NEVER in plaintext** — always `encryptTokens()` before DB write, `decryptTokens()` before use
- **Token encryption key has NO hardcoded fallback** — missing key = throw, never silent default
- **Webhook handlers return 200 immediately** — enqueue job, process async (Meta retries on timeout)
- **Every DB query scoped by workspace_id** — never query cross-workspace
- **No secrets in commit messages** (AGPL project = public history)
- **NEVER `bun install` / `npm install` on server** — always prebuild artifacts, deploy via Docker

## Phases

| Phase | What | Status |
|-------|------|--------|
| 0 | Project skeleton, auth, Docker Compose | done |
| 1 | OAuth channels (FB + IG), webhook receiver | done |
| 2 | Inbox core, manual reply, BullMQ worker | done |
| 3 | Rule engine (keyword auto-reply) | done |
| 4 | Sequences (drip campaigns) | done |
| 5 | Comment automation (comment → DM) | done |
| 6 | Contacts CRM | done |
| 7 | API keys, token refresh, settings page, cron | done |
| 8 | OpenAPI spec (basic, Scalar UI), open source publish | done |
| 9 | Visual flow builder (v2) | future |

## Pre-publish Checklist

`vault/brands/_shared/prompts/checklists/opensource-publish.md`
Pay special attention to: section 7a (Meta/OAuth/Webhooks), section 9 (AGPL).

## Brand

Standalone open source project. No direct brand affiliation (Flowgrammer potential home).
