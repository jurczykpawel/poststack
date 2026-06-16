# Changelog

All notable changes to ReplyStack will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

## [0.4.21] - 2026-06-16

### Added

- **Unified Compose.** The composer is now a single screen to author *and* publish a post with every content automation wired in:
  - Per-platform **Automation** section — **first comment** (auto-posted under the post), **Auto-Story** (share to Story on publish, Meta), and **comment-keyword → DM auto-reply** — each capability-gated to the platforms that support it and stored on the post (`first_comment`, `auto_story`, `auto_reply`).
  - **Publish section** — Save as draft, Publish now, or Schedule, straight from the composer (each post goes to its brand-resolved channel; the automations fire on publish).
- Per-post overrides flow through the publish request, so a post can override the channel-level first-comment / Auto-Story defaults.

## [0.4.20] - 2026-06-16

### Added

- **Contact names in the inbox.** Meta DM webhooks deliver only the sender's PSID/IGSID, so a new contact showed as a raw numeric id. The inbox now resolves the sender's public profile (name + avatar; username on Instagram) via the Meta User Profile API when a contact is first created, and displays the name. Best-effort — a failed lookup never blocks message processing, and an existing name/avatar is never overwritten.

## [0.4.19] - 2026-06-16

### Added

- **Meta 24h messaging-window handling.** A manual human reply sent after Meta's 24-hour standard messaging window now goes out with the `HUMAN_AGENT` message tag (allowed up to 7 days) instead of being rejected (`#10` / subcode `2018278`). Automated rule replies stay on `RESPONSE` (bots may not use `HUMAN_AGENT`, and they fire inside the window anyway).
- **Inbox window indicator.** The reply composer shows a heads-up when the window is closing or closed: "24h reply window closes in Xh", "24h window closed — sending as a human-agent message (allowed up to 7 days)", or "outside the 7-day messaging window — Meta will likely reject this reply". Informational only — it never blocks sending.

## [0.4.18] - 2026-06-16

### Fixed

- **License revocation now actually works.** The CRL consumer compared a token's raw `order` claim against an `orders` field the seller never publishes, so a revoked (e.g. refunded) license was never refused. It now hashes the `order` (SHA-256) and matches against the published `order_hashes`.

### Changed

- Consume the revocation list as a **k-anonymity prefix range query**: the gate sends only a short hex prefix of `SHA-256(order)` and checks full-hash membership locally, so the server never sees the full hash or the total revocation count. Cache is keyed per prefix bucket; fail-open semantics on a CRL outage are unchanged (never lock out a paying customer).

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
