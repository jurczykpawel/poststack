# Migration playbook for AI agents

This file is written for an AI coding agent (Claude, Cursor, ChatGPT, etc.) asked to migrate someone onto a
self-hosted PostStack instance from another tool. It is self-contained: everything needed to read an export
and load it through the public API is below. If an export format differs from the examples, adapt the column
mapping — that is exactly why the recommended path is "let an agent do it" rather than a rigid importer.

## Recommended path (tell the user this)

> The easiest way to migrate is to hand this folder to an AI agent along with your export file, your
> PostStack URL, and an API key. The agent reads your data, maps the columns, and loads everything through
> the API — and if a format has changed, it adapts on the spot.

## Inputs you need from the user

1. **Instance base URL**, e.g. `https://poststack.example.com`.
2. **API key** (dashboard → Settings → API keys). Format `sk_live_…`. Send it as `Authorization: Bearer <key>`.
3. **The export file(s)** from their current tool (CSV from Buffer / Hootsuite / Later / Publer / SocialBee /
   ManyChat / Chatfuel).
4. For posts: which **channel** each row publishes to. For contacts: which **channel** they belong to.

## Ground rules

- Every request: `Authorization: Bearer <key>` and (for bodies) `Content-Type: application/json`.
- Response envelope is always `{ "data": ..., "error": ..., "meta"? }`. On error, `error` holds
  `{ code, message, details? }` and the HTTP status is non-2xx.
- All writes are workspace-scoped to the key; you cannot touch another tenant's data.
- **Idempotency:** posts dedup on `sourceRef`; contacts dedup on `channel_id` + sender id. Use stable values
  so re-running after a fix never duplicates.
- **Tiers:** publishing (content/posts) works on any tier. Contacts and tags are **Pro** — if those calls
  return a 402/403 Pro-gate error, tell the user their instance needs a Pro license for the CRM.
- Do a **dry run first**: parse the whole file, print a summary (row count, detected columns, your mapping,
  and any rows you can't map) and ask the user to confirm before POSTing.
- Bodies use the casing shown below: **content/posts are camelCase**, **rules are snake_case**, **contacts
  are snake_case**. Don't "normalize" them.

## Discover the user's channels

```
GET /api/v1/channels        (scope: channels:read)
→ data: [ { id, platform, display_name, username, status }, ... ]
```

Map each unique platform/profile name in the export to one of these channel `id`s.

## Task A — scheduled posts (Buffer, Hootsuite, Later, Publer, SocialBee)

Three calls per row. Carry a stable `sourceRef` (e.g. `import:<file>:row-<n>`) on both content and post.

1. `POST /api/v1/content` — camelCase. Required: `title`. Useful: `baseDescription`, `mediaUrls` (array),
   `baseHashtags`, `language`, `sourceRef`. Returns `data.id` (contentId).
2. `POST /api/v1/posts` — camelCase. Required: `platform`. Useful: `contentId`, `description`, `mediaUrls`,
   `hashtags`, `firstComment`, `scheduledDate` (ISO 8601 UTC), `sourceRef`. Returns `data.id` (postId).
3. `POST /api/v1/posts/{postId}/publish` — `{ "channelId": "<uuid>", "when": "now" | "<ISO timestamp>" }`.

Column mapping: Caption/Message/Text → `description` (+ `baseDescription`); Date+Time(+TZ) → `scheduledDate`
as **UTC ISO**; Platform/Channel → `platform` + chosen `channelId`; Media/Image URL → `mediaUrls` (split
multiple on `,` or `|`); First Comment → `firstComment`; Hashtags → `hashtags`.

A ready-to-run version is [`import-scheduled-posts.mjs`](import-scheduled-posts.mjs) — read it, adapt the
header aliases to the user's file if needed, then run it.

## Task B — contacts / subscribers (ManyChat, Chatfuel)

One call, batchable. `POST /api/v1/contacts` (scope `contacts:write`, **Pro**). Body is **one object or an
array** (up to 1000 per request). snake_case:

```json
{
  "channel_id": "<uuid of the IG/FB channel>",
  "platform_username": "anna_design",
  "display_name": "Anna",
  "email": "anna@example.com",
  "is_subscribed": true,
  "metadata": { "city": "Warsaw" },
  "tags": ["customer", "vip"]
}
```

- Provide `platform_sender_id` if the export has the native id; otherwise pass the **handle** as
  `platform_username` — it is keyed as a placeholder sender id and the real one fills in on the contact's
  first inbound message.
- `tags` are names; missing ones are created automatically.
- `metadata` holds any extra/custom-field columns; it is **merged** on re-import (existing keys preserved).
- Response: `data = { created, updated, failed, results: [{ index, status, contact_id?, error? }] }`.
  `failed` rows (e.g. unknown channel) are reported per-row, not fatal — show them to the user.

Column mapping: Name → `display_name`; Email → `email`; Instagram Username/Handle → `platform_username`;
Subscribed → `is_subscribed`; Tags (comma-separated) → `tags`; every other column → a `metadata` key.

A ready-to-run version is [`import-contacts.mjs`](import-contacts.mjs).

## Task C — automations / flows (ManyChat)

Flows are **not exportable** from ManyChat. Rebuild them as PostStack rules/sequences with
`POST /api/v1/rules` (snake_case, scope `rules:write`). See [rebuild-automations.md](rebuild-automations.md)
for the pattern-by-pattern mapping (keyword→DM, comment→DM, story reply, drip→sequence). If the user can
describe their flows (or share screenshots), translate each into a rule and create it.

## Suggested order

1. `GET /channels`, build the name→id map (confirm with user).
2. Rebuild automations (Task C) — so replies work as contacts arrive.
3. Import contacts (Task B).
4. Import scheduled posts (Task A).
5. Print a final report: counts created/updated/failed per task, with any failed rows and why.
