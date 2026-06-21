# Changelog

All notable changes to PostStack will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [Unreleased]

## [0.7.5] - 2026-06-21

### Fixed

- **Landing: the “Live fleet” stats now actually appear.** The section fetches the public telemetry endpoint client-side, but the app’s Content-Security-Policy (`connect-src 'self'`) silently blocked the cross-origin request, so the section stayed hidden. `connect-src` now allows `https://telemetry.techskills.academy`.

## [0.7.4] - 2026-06-21

### Fixed

- **Landing: point app links at the real domain.** The marketing site referenced a separate `app.poststack.techskills.academy` host that does not exist (its “Open the app” links were dead). The app and its marketing page are a single deployment on one domain, so those links now point at `https://poststack.techskills.academy/login` and the FAQ wording was corrected.

## [0.7.3] - 2026-06-21

### Added

- **Landing: per-platform fleet breakdown.** The “Live fleet” section now shows a per-platform breakdown of connected channels (animated bars with platform glyphs) alongside the headline counters, drawn from the public telemetry endpoint’s aggregate data. Reveals only when there are reporting instances.

### Changed

- **Landing: privacy page now discloses telemetry.** Added an “Anonymous usage telemetry” section to the privacy page (what an aggregate snapshot contains, what it never contains, the opt-out env var, and a link to `docs/PRIVACY.md`); the fleet section deep-links to it. Mobile fleet cards render 2-up.

## [0.7.2] - 2026-06-20

### Added

- **Dashboard stats caching.** The webhook and engagement stats tiles now reuse their last computed aggregate for a short window instead of re-scanning the underlying tables on every dashboard load. Configurable via `STATS_CACHE_TTL_MS` (default 30000 ms; set `0` to always compute live). No schema change.

### Changed

- **Self-hosting docs.** Sharpened the README + deploy guide for self-hosters (prebuilt images, HTTPS-in-front guidance, Meta OAuth redirect URIs).

## [0.7.1] - 2026-06-19

### Added

- **Telemetry: per-platform breakdown.** The anonymous daily usage snapshot now includes a per-platform breakdown of messages sent and webhooks processed (and comment replies) — counts only, grouped by platform (e.g. Facebook, Instagram). Still no message content, contact data, tokens, or secrets.

## [0.7.0] - 2026-06-19

### Added

- **Landing: TechSkills Academy ecosystem footer.** The marketing footer links back to the hub ("Part of the TechSkills Academy ecosystem · All tools · Open source"), per the ecosystem-footer standard.
- **Landing: cookie consent + privacy.** A consent manager (vanilla-cookieconsent) with "Cookies" and "Privacy" footer links and a `/privacy` page (now served by the app).
- **Landing: runtime-configured, privacy-first analytics.** Cookieless Umami + optional server-side GTM (GA4 + Meta CAPI). The app injects the config (`window.__POSTSTACK_ANALYTICS__`) into the served HTML from its environment — nothing is baked into the image. Set `LANDING_UMAMI_WEBSITE_ID` / `LANDING_GTM_ID` (+ optional `LANDING_UMAMI_SRC`) to enable; unset (e.g. on staging) ⇒ zero trackers, no banner. Self-hosters point it at their own analytics. Umami is cookieless; GTM loads only after consent.
- **Response-time metrics.** PostStack now records how quickly each inbound comment/DM is handled: webhook processing time and time-to-first-reply (intentional sequence delays excluded — only immediate replies are timed). View per-platform answer rate and average first-reply time on the overview, or via `GET /api/v1/stats/response-times` (scope `stats:read`). Metrics roll up daily and survive history compaction.
- **Anonymous usage telemetry (opt-out).** Self-hosted instances send the maintainer an anonymous daily snapshot — a random instance id, a salted hash of the domain (never the domain itself), deployment shape (versions, platform/integration on-off flags), and aggregate counts — to inform the roadmap. **No message content, contact data, tokens, or secrets are ever sent.** Enabled by default; disable with `POSTSTACK_TELEMETRY_DISABLED=true`, or repoint with `TELEMETRY_URL`. See [`docs/PRIVACY.md`](docs/PRIVACY.md).

## [0.6.1] - 2026-06-18

### Changed

- **Dependency bumps.** graphile-worker 0.17, zod 4.4, pg 8.21, @hono/node-server 2.0.5, @playwright/test 1.61, and the Docker build GitHub Actions (build-push v7, setup-buildx v4, login v4). No functional changes.

## [0.6.0] - 2026-06-18

### Added

- **Auto-Story templates.** Auto-published Story cards now use a selectable template — `framed`, `phone`, `fullbleed` or `classic` — chosen per brand, styled with the brand's accent + name, with a live preview on the Brands page. (Custom/imported templates are a planned PRO extension.)
- **AI rephrasing for any OpenAI-compatible provider.** Provider-neutral settings (`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`; legacy `OPENAI_*` still honored) so you can point rephrasing at OpenAI, OpenRouter, Groq, a local Ollama, etc. A "rephrase with AI" toggle is now available directly in the rule editor.
- **Approvals: public comment + DM together.** A comment-triggered rule (`reply_mode` comment/both) held for approval now parks BOTH the public comment reply and the DM, and approving sends both. Approvals also gained a "Recently resolved" history (sent/rejected) and an "open in inbox" deep-link.
- **Inbox search & date filters.** Filter conversations by contact name, a rolling date window, or a custom from–to range.

### Changed

- **Approvals redesigned** into scannable cards showing who the reply goes to, the triggering message, and the exact comment/DM that will be sent.
- **Settings reorganized into tabs** (Account · API keys · License · Integrations · Sources · Automation · Data); Sources and API keys now live under Settings. The Webhooks page is reorganized into tabs. Credential rows redesigned for readability.
- **`.env.example`** rewritten to document every supported variable.

## [0.5.0] - 2026-06-17

### Added

- **Marketing homepage.** `poststack.techskills.academy` now serves the PostStack landing page at `/` (anonymous visitors see the marketing site; logged-in users go straight to the panel). The app, its login, and all OAuth/webhook endpoints keep their existing URLs — no domain change.
- **PostStack PRO licenses on sale.** Two purchasable licenses wired into the landing: PRO annual and a one-time Lifetime, with introductory launch pricing through 31 Jul 2026. A self-hosted install validates a license from the whole PostStack product family out of the box.

### Added

- **Automatic history compaction.** Webhook events and post reactions older than HISTORY_RETENTION_DAYS (default 60) are rolled into compact aggregates and deleted, keeping the database small on shared/limited Postgres — all-time counts and the Engagement view stay correct (only raw payloads and reactor identity are dropped). Set HISTORY_RETENTION_DAYS=0 to keep everything.

## [0.4.32] - 2026-06-17

### Changed

- **Brand limit is now enforced at runtime, not just when creating a brand.** On the free plan an instance that already had several brands (from a seed, migration, or a downgrade from Pro) kept publishing through all of them. Now brands beyond the plan's limit are shown as **🔒 PRO** on the Brands page (still visible, with an upgrade link) and are excluded from composing and publishing — the oldest brand stays active. Licensed plans are unaffected (unlimited brands).

### Fixed

- A stored license token that can no longer be decrypted (e.g. after rotating `ENCRYPTION_KEY`) no longer breaks the license check — it now falls back to the free plan instead of erroring, so publishing keeps working.

## [0.4.31] - 2026-06-17

### Added

- **More credentials configurable in Settings** (extends the Meta-only support): Google/YouTube OAuth (client id + secret), AI rephrase (OpenAI-compatible API key, base URL, model), the channel-alert and ReelStack webhook secrets, and the ALTCHA CAPTCHA key. Each is stored encrypted, overrides its env var, and is grouped by integration in Settings — set them from the dashboard instead of editing `.env`.

### Changed

- **Smoother UI motion.** Page navigations and htmx swaps now use the View Transitions API where supported (disabled under reduced-motion), and the binary on/off toggles render as switches.

### Internal

- Deploy housekeeping prunes unused images aggressively (the test host had been filling up with old tagged images); added publishing-layer Graph-API-version contract tests; squashed the migrations into a single baseline (pre-release).

## [0.4.30] - 2026-06-17

### Added

- **Set your Meta app credentials in the dashboard (no more editing `.env`).** Settings → *Meta App configuration → Your credentials* lets you paste your **App ID**, **App Secret**, and **Webhook Verify Token** straight into the app. Values are stored **encrypted** (AES-256-GCM) and a value set here **overrides** the matching environment variable, taking effect without a redeploy. Secrets are never shown back — only a masked "set" indicator — and a *Clear* button reverts a field to its env var. Existing env-based deploys keep working unchanged (a key with no dashboard value falls back to its env var). Foundation is generic — more credential groups (Google/YouTube, AI, webhooks) will follow on the same mechanism.

## [0.4.28] - 2026-06-17

### Changed

- **Relicensed from AGPL-3.0 to the Elastic License 2.0 (source-available).** You can still self-host, use, modify, and redistribute PostStack freely; the new limits are that you may not offer it to third parties as a hosted/managed service and may not circumvent the license-key functionality. Added a Contributor License Agreement (`CLA.md`) that lets the project relicense in the future (e.g. to a more permissive license).
- **Repositioned the project as "PostStack"** — a self-hosted social media *management* platform (publishing & scheduling + inbox auto-replies + drip sequences + CRM), not just an inbox-automation / ManyChat alternative. Updated README, CONTRIBUTING, API docs, and the package description accordingly.

## [0.4.27] - 2026-06-17

### Changed

- **Filters apply instantly — no "Apply" click.** The filter bars on Content, Channels and Queue now apply on interaction (selects on change, the search box debounced as you type), like the inbox. The redundant "Apply" button is hidden (kept as a no-JS fallback).
- **Content status filter is now a dropdown built from your actual statuses** instead of a free-text box you had to type into. Statuses are open-set (NocoDB import), so the options are derived from the statuses present in your workspace (plus a deep-linked value is always included).

## [0.4.26] - 2026-06-17

### Changed

- **Auto-Story and the automatic First comment are now PRO features** (publishing area). On a free instance the channel panels show a "🔒 (PRO)" upgrade prompt instead of the controls, the compose per-post overrides are hidden, and — the authoritative gate — the publish worker never enqueues a Story or first-comment for an unlicensed instance even if a toggle was left on from a lapsed license.

### Fixed

- **"Published posts" (and "Queue →") in the channel view now filter to that channel.** They linked to the unfiltered `/queue`; they now carry `?channel=<id>` so you see only that channel's posts (the queue already supported the filter).

## [0.4.25] - 2026-06-17

### Fixed

- **Channel Auto-Story (and First comment) toggles now update in place — no page reload.** Their forms targeted `#ch-detail-head`, but the panels (button + "Currently on/off" status) live in separate sections, so toggling left them stale until a manual refresh. The actions now return the affected panel as an htmx out-of-band swap, so the label/status flip immediately alongside the toast.

### Added

- **In-flight feedback on every action.** Any control issuing an htmx request now shows a spinner, dims, and blocks re-clicks until the request completes — no more "dead" clicks where nothing visibly happens. Applies app-wide via a single `.htmx-request` style.

## [0.4.24] - 2026-06-17

### Fixed

- **Publishing now uses the same Graph API version as messaging.** The publishing layer (`providers/meta.ts` — post/reel/photo/video/story publish, media containers, token introspection) had a **hardcoded `v21.0`** while the inbound/messaging layer was on `v25.0`, so bumping `META_API_VERSION` silently left publishing two years behind. The publishing layer now derives its version from the single source of truth (`GRAPH_API_BASE`), and a guard test fails the build if any Meta module reintroduces a hardcoded version literal.

### Added

- **Meta Graph API version-bump verification.** `META_API_VERSION` lives in one place (`src/lib/platforms/constants.ts`). Two new tools de-risk bumping it:
  - A **single-source-of-truth guard test** — fails if any platform/provider module hardcodes a `graph.facebook.com/vNN.N` literal instead of `GRAPH_API_BASE`.
  - A **live version-probe** (`scripts/meta-version-probe.ts`, `npm run probe:meta`) — hits the real Graph API on a target version with real tokens and reports a deterministic PASS/FAIL per endpoint/field our parsers depend on (debug_token, `/me`, page node, `subscribed_apps`, feed, IG identity + follow check, and an opt-in publish→first-comment→DM→delete write cycle). Env-gated (skips cleanly without creds), exit code reflects failures — run it before bumping to see exactly what changed.

## [0.4.23] - 2026-06-17

### Added

- **Rules can enroll a contact into a drip sequence.** A rule's response type can now be **"Enroll in a drip sequence"** (`response_type: "sequence"` + `response_config.sequence_id`): when the trigger (DM/comment keyword, postback, welcome, reaction, …) fires, the matched contact is enrolled into the chosen sequence and its first step is scheduled. Enrollment is once-per-contact (idempotent), respects the rule's cooldown/cap, and is gated to the `sequences` PRO feature. Previously a `sequence` rule was a no-op placeholder the API rejected.
  - **Rules UI**: the response picker offers the sequence option (with a sequence selector) on create *and* edit; the rule list shows `🧵 enroll → <sequence>`.
  - **Compose**: a comment auto-reply can choose **"Enroll in a drip sequence"** instead of sending a DM — the publish loop-back provisions a `sequence` rule scoped to the published media.
  - **API**: `POST`/`PATCH /api/v1/rules` accept `sequence` and validate that `sequence_id` points at an *active* sequence in the workspace (422 otherwise). The enroll endpoint and the rule engine now share one transactional-outbox enrollment helper.

## [0.4.22] - 2026-06-17

### Fixed

- **Comment → DM auto-reply no longer leaves a duplicate row in the thread.** The private-reply send returned no message id, so the inbound echo of our own DM was logged as a second outbound message (cosmetic — the recipient still got a single DM). `sendPrivateReply` now returns the Graph `message_id` and the worker stores it, so the echo dedups correctly.

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
