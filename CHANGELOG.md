# Changelog

All notable changes to ReplyStack will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

## [0.1.0] - 2026-06-06

First public release.

### Added

- Facebook Pages and Instagram Business OAuth channel connection, plus a manual System-User token mode for non-expiring connections
- Meta webhook receiver with HMAC-SHA256 signature verification and per-channel secrets
- Auto-reply rule engine with triggers for keyword, comment keyword, postback, welcome, story reply, story mention, emoji reaction, and fallback/default -- with per-contact cooldown
- Comment automation: reply publicly under the comment, send a private DM (Meta `private_replies`) on first touch, or both -- scoped to a specific post or all posts, on Facebook and Instagram
- Optional AI rephrasing of any reply (including a random pool) via an OpenAI-compatible endpoint
- Live inbox: conversation list, message thread, manual reply, mark read / close / pause automation
- Drip sequences with configurable per-step delays and API-driven enrollment
- Contacts CRM with full-text search, color-coded tags, and subscription state
- API key management and automatic OAuth token refresh
- API-first REST surface at `/api/v1/*` with Bearer auth and interactive Scalar docs at `/api/docs`
- Channel health detection (auth failures flag `needs_reauth`) with optional outbound alert webhook, plus a circuit breaker that parks and drains outbound traffic during an outage
- Message retention pruning and an append-only audit log
- Docker Compose one-command startup; production compose with nginx + pre-built GHCR images
- Optional NocoDB integration (spreadsheet view of all data)

### Architecture

- Web and worker run on **Hono** + **Bun**; UI is server-rendered `hono/html` with htmx + Alpine (no client framework)
- **PostgreSQL** + **Drizzle ORM**; **graphile-worker** for the job queue -- no Redis (rate limiting, JWT denylist, and outgoing-message idempotency are all Postgres-backed)
- OAuth tokens encrypted at rest with AES-256-GCM
