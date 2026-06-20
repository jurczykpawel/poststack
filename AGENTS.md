# AGENTS.md - PostStack

## Project Overview

**PostStack** — self-hosted, source-available Meta (Facebook + Instagram) social media
management platform: publishing & scheduling + inbox auto-replies + drip sequences + CRM.
**Elastic License 2.0** (source-available, NOT open-source/AGPL — see LICENSE + CLA.md).
One-command startup via Docker Compose.

Alternative to ManyChat / Buffer / Hootsuite, without vendor lock-in.

## Task Tracking (private — never commit)

All planned work lives as **one task per file** under `priv/tasks/*.md`. This directory is **gitignored** — it must never land in the public history.

**Always use this system. Do not invent ad-hoc TODO lists.**

- **Read `priv/tasks/INDEX.md` first** — it's the board (every task with status + priority).
- **One task = one file.** Never lump multiple tasks into a single file. New task → new `priv/tasks/<ID>-<slug>.md` with frontmatter: `id, title, status, priority, area, epic, depends_on, created, tags`.
- **Status:** `queued` | `active` | `parked` | `done`. **Priority:** 1–100 (higher = pilniejsze).
- Starting work → set `status: active`. Finishing → set `status: done` and update `INDEX.md`.
- Found a stray TODO/note (incl. `TODO.md`)? Migrate it into a `priv/tasks/` file; don't leave parallel backlogs.

## Stack

| Layer | Tech |
|-------|------|
| Framework | Hono (web server + API), `hono/html` SSR |
| UI | Server-rendered HTML + htmx + Alpine.js (no client framework) |
| Language | TypeScript 5 |
| Database | PostgreSQL + Drizzle ORM |
| Queue | PostgreSQL (graphile-worker) |
| Styling | Plain CSS (CSS variables, dark theme) — no UI framework |
| Platforms | Facebook, Instagram (extensible via provider pattern) |
| Auth | Custom JWT (jose) |
| Encryption | AES-256-GCM (Node.js crypto) |
| Runtime | Bun (web + worker); Vitest on Node for tests |
| Infra | Docker Compose |

## Architecture

```
Web process (Hono, on Bun):
  - src/server/app.ts             → Hono app: security headers, CORS, routing
  - /api/webhooks/meta            → enqueue jobs
  - /api/oauth/facebook|instagram → OAuth callbacks
  - /api/cron/token-refresh       → token refresh trigger
  - /api/v1/*                     → REST API (handlers in src/server/handlers/v1, delegated)
  - /inbox, /channels, ...        → server-rendered dashboard (htmx + Alpine)

Worker process (graphile-worker, on Bun):
  - incoming-messages worker  → contact upsert → rule engine → enqueue reply
  - outgoing-messages worker  → Meta Graph API send
  - token-refresh worker      → refresh expiring OAuth tokens
  - sequence-steps worker     → deliver drip sequence messages
```

## Landing / marketing site (READ THIS before "deploying the landing")

The `landing/` Astro site is **NOT a separate deployment** and does **NOT** live on a separate
domain or Cloudflare Pages. It is **built into the app Docker image** and served by the app itself:

- `docker/Dockerfile` has a `landing` build stage (`npm run build` in `landing/`) and copies
  `landing/dist` into the runtime image.
- `src/server/routes/landing.ts` (`serveLandingFile`) serves it at `/` and `/privacy` (+ `/_astro/*`).
  Logged-out visitors see the marketing site; logged-in visitors are redirected to `/overview`.

**So the landing and the app are one deployment, on one domain (`poststack.techskills.academy`).**
To ship landing changes, **cut a normal app release** (bump version → tag `v*` → `release.yml` builds the
image incl. the fresh `landing/dist` → auto-deploy TEST → manual PROD). There is no CF Pages step and no
DNS cutover. (The `app.poststack.techskills.academy` split mentioned in some marketing copy was an
abandoned plan — a cert issue on the subdomain — so the app currently lives on the apex; treat any
"app on a subdomain / deploys independently" wording as stale.)

## API-First Design

PostStack is API-first. All features exposed via REST at `/api/v1/*`.

- **Dual auth:** session JWT cookie (dashboard) + `Authorization: Bearer rs_live_<key>` (external)
- **CORS:** enabled on all `/api/v1/*` routes
- **OpenAPI spec:** `src/lib/api/openapi.ts` — update when adding new routes
- **Scalar UI:** `/api/docs` (no npm dep, CDN-loaded)
- **Response shape:** always `{ data, error, meta? }` — use helpers from `src/lib/api/response.ts`
- **Auth helper:** `authenticate(request)` from `src/lib/auth/index.ts` — handles both auth methods

## Key Directories

```
src/
├── server/               # Hono app
│   ├── app.ts            #   factory: security headers, CORS, route mounting; index.ts (entry)
│   ├── routes/           #   public/v1/special/pages/dashboard routers
│   ├── handlers/         #   framework-neutral HTTP handler modules (routes delegate here)
│   ├── ui/               #   hono/html templates + CSS
│   └── middleware/       #   security-headers, page-auth
├── lib/
│   ├── platforms/        # SocialProvider base class + FB/IG implementations
│   ├── rules/            # matcher.ts + executor.ts (keyword auto-reply)
│   ├── auth/             # JWT sessions + API keys
│   ├── queue/            # graphile-worker client (addJob + task list)
│   ├── workers/          # Worker implementations (graphile tasks)
│   ├── crypto.ts         # Token encryption/decryption
│   └── db.ts             # Drizzle client singleton
src/db/
├── schema.ts            # Full schema (contacts, channels, rules, flows, sequences) + enums
└── relations.ts         # Drizzle relational-query relations
worker/
└── inbox-worker.ts       # graphile-worker entrypoint (separate process)
drizzle/
└── 0000_init.sql         # Generated SQL migrations (drizzle-kit)
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

# Install + migrate (npm for deps + drizzle-kit; runtime is Bun)
npm install
npm run db:migrate

# Run web (Hono on Bun, terminal 1)
npm run dev

# Run worker (graphile-worker on Bun, terminal 2)
npm run worker
```

## Environment Variables

See `.env.example`. Required:

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | Passphrase >= 32 chars, sha256-derived (`openssl rand -base64 32`) |
| `JWT_SECRET` | Auth JWT secret |
| `META_APP_ID` | Facebook App ID |
| `META_APP_SECRET` | Facebook App Secret |
| `APP_URL` | Public URL (for OAuth redirect + webhook URL display) |
| `CHANNEL_ALERT_WEBHOOK_URL` | Optional. Outbound webhook POSTed when a channel needs re-auth |
| `HISTORY_RETENTION_DAYS` | Optional. Compaction window in days; 0 = off; default 60; if set must be >= 30 |

## Important Rules

- **ALWAYS read `vault/brands/_shared/reference/coding-standards.md` before writing code**
- **Security:** See `vault/brands/_shared/prompts/checklists/security.md`
- **OAuth tokens NEVER in plaintext** — always `encryptTokens()` before DB write, `decryptTokens()` before use
- **Token encryption key has NO hardcoded fallback** — missing key = throw, never silent default
- **Webhook handlers return 200 immediately** — enqueue job, process async (Meta retries on timeout)
- **Every DB query scoped by workspace_id** — never query cross-workspace
- **No secrets in commit messages** (public repo = public history)
- **NEVER `npm install` on server** — always prebuild artifacts, deploy via Docker
- **Schema: every status/state is an enum from day 1** — never a `String` with an enumerating comment, never a new boolean per state. Each `*_id` column has a Drizzle `foreignKey` with an explicit `onDelete`.

## Phases

| Phase | What | Status |
|-------|------|--------|
| 0 | Project skeleton, auth, Docker Compose | done |
| 1 | OAuth channels (FB + IG), webhook receiver | done |
| 2 | Inbox core, manual reply, queue worker (graphile-worker) | done |
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

Part of the **TechSkills Academy** ecosystem (`techskills.academy`) — listed under `/narzedzia`, footer links back to the hub. Source-available product, but not brand-orphaned: it lives under the TSA umbrella. (Flowgrammer is a TSA sub-brand, not a separate/peer brand.)
