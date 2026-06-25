# Migrating to PostStack

Moving from a hosted tool like Buffer, Hootsuite, Later, Publer, SocialBee, or ManyChat? PostStack is
self-hosted and API-first, so you bring your data in yourself — no per-contact subscription, no vendor
lock-in, and nothing leaves your server.

There is **no import wizard to babysit**. Instead, you export your data from your current tool (every one
of them gives you a CSV) and push it into your PostStack instance through the public `/api/v1` API. That
keeps migration transparent and under your control.

## Easiest path: let an AI agent do it

The simplest way to migrate is to hand this folder to an AI agent (Claude, Cursor, ChatGPT, …) together
with **your export file**, your **PostStack URL**, and an **API key**, and ask it to migrate you. The agent
reads your data, maps the columns, and loads everything through the API — and because it reasons about your
actual file, it adapts if a tool's export format has changed. Point it at **[for-agents.md](for-agents.md)**,
which is a complete, self-contained playbook (API contract, field mappings, and the step order) written for
exactly this.

Prefer to do it by hand? The per-tool guides below have copy-paste `curl` examples and ready-to-run
reference scripts ([`import-scheduled-posts.mjs`](import-scheduled-posts.mjs),
[`import-contacts.mjs`](import-contacts.mjs)).

## What you can move

| From | What | How | Guide |
|------|------|-----|-------|
| Buffer / Hootsuite / Later / Publer / SocialBee | Scheduled & queued posts | CSV export → `POST /api/v1/content` + `/posts` + `/posts/{id}/publish` | [from-buffer.md](from-buffer.md) |
| ManyChat / Chatfuel | Subscribers, tags, custom fields | CSV export → `POST /api/v1/contacts` (bulk, idempotent) | [from-manychat.md](from-manychat.md) |
| ManyChat / Chatfuel | Automations / flows | Rebuilt as PostStack rules & sequences (flows are not exportable) | [rebuild-automations.md](rebuild-automations.md) |

## What you cannot move (and why)

- **ManyChat flows / automations** — ManyChat does not expose them as machine-readable data (export is only
  a PNG or a share link). You rebuild them as PostStack rules and sequences — usually a 10-minute job, and
  we map the common patterns for you in [rebuild-automations.md](rebuild-automations.md).
- **Follower / audience lists on Instagram & Facebook** — those are owned by the platform, not by your old
  tool, so there is nothing to export beyond the contacts the tool actually captured.
- **Message history from ManyChat** — its export gives you the current state of a contact, not the full
  conversation thread.

## Before you start: create an API key

1. Open your PostStack dashboard → **Settings → API keys**.
2. Create a key. It is shown **once** and looks like `sk_live_…`.
3. Scope it to what you need:
   - Posts and editorial content need **only a valid key** (no special scope).
   - Tags need **`tags:write`**, contacts need **`contacts:write`**, listing channels needs
     **`channels:read`**.
   - Tags and contacts are part of the CRM, which is a **Pro** feature — those endpoints require a Pro
     license. Publishing works on any tier.

Authenticate every request with:

```
Authorization: Bearer sk_live_your_key_here
```

All endpoints are documented interactively at `/api/docs` on your own instance.
