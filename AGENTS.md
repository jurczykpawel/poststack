# AGENTS.md - ReplyStack

## Project Overview

**ReplyStack** — self-hosted, open-source Meta (Facebook + Instagram) inbox automation platform.
AGPL-3.0. One-command startup via Docker Compose.

Alternative to ManyChat / ZernFlow, without vendor lock-in.

## Task Tracking (private — never commit)

All planned work lives as **one task per file** under `priv/tasks/*.md`. This directory is **gitignored** — it must never land in the AGPL public history.

**Always use this system. Do not invent ad-hoc TODO lists.**

- **Read `priv/tasks/INDEX.md` first** — it's the board (every task with status + priority).
- **One task = one file.** Never lump multiple tasks into a single file. New task → new `priv/tasks/<ID>-<slug>.md` with frontmatter: `id, title, status, priority, area, epic, depends_on, created, tags`.
- **Status:** `queued` | `active` | `parked` | `done`. **Priority:** 1–100 (higher = pilniejsze).
- Starting work → set `status: active`. Finishing → set `status: done` and update `INDEX.md`.
- Found a stray TODO/note (incl. `TODO.md`)? Migrate it into a `priv/tasks/` file; don't leave parallel backlogs.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Database | PostgreSQL + Prisma |
| Queue | PostgreSQL (graphile-worker) |
| Styling | Plain CSS (CSS variables, dark theme) — no UI framework |
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

Worker process (graphile-worker):
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
│   ├── rules/            # matcher.ts + executor.ts (keyword auto-reply)
│   ├── auth/             # JWT sessions + API keys
│   ├── queue/            # graphile-worker client (addJob + task list)
│   ├── workers/          # Worker implementations (graphile tasks)
│   ├── crypto.ts         # Token encryption/decryption
│   └── prisma.ts         # PrismaClient singleton
├── components/           # React components (inbox, rules, channels, ui)
worker/
└── inbox-worker.ts       # graphile-worker entrypoint (separate process)
prisma/
└── schema.prisma         # Full schema (contacts, channels, rules, flows, sequences)
docker/
├── Dockerfile
├── Dockerfile.worker
└── nginx.conf
```

## Reference Implementations

Design was informed by internal reference implementations kept in a private workspace (not part of this public repo): a flow engine, a trigger matcher, a platform adapter, and a set of self-hosted n8n reference workflows. The relevant interfaces are documented inline throughout this file.

## Development

```bash
# Start dependencies
docker compose up postgres nocodb

# Install + migrate
npm install
npm run db:migrate

# Run web (terminal 1)
npm run dev

# Run worker (terminal 2)
npm run worker
```

## Environment Variables

See `.env.example`. Required:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `TOKEN_ENCRYPTION_KEY` | 32-byte hex (`openssl rand -hex 32`) |
| `JWT_SECRET` | Auth JWT secret |
| `META_APP_ID` | Facebook App ID |
| `META_APP_SECRET` | Facebook App Secret |
| `NEXT_PUBLIC_APP_URL` | Public URL (for OAuth redirect + webhook URL display) |
| `CHANNEL_ALERT_WEBHOOK_URL` | Optional. Outbound webhook POSTed when a channel needs re-auth |

## Important Rules

- **ALWAYS read `vault/brands/_shared/reference/coding-standards.md` before writing code**
- **Security:** See `vault/brands/_shared/prompts/checklists/security.md`
- **OAuth tokens NEVER in plaintext** — always `encryptTokens()` before DB write, `decryptTokens()` before use
- **Token encryption key has NO hardcoded fallback** — missing key = throw, never silent default
- **Webhook handlers return 200 immediately** — enqueue job, process async (Meta retries on timeout)
- **Every DB query scoped by workspace_id** — never query cross-workspace
- **No secrets in commit messages** (AGPL project = public history)
- **NEVER `npm install` on server** — always prebuild artifacts, deploy via Docker

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
