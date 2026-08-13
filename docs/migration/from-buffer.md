# Migrating scheduled posts (Buffer, Hootsuite, Later, Publer, SocialBee)

All of these tools let you export your content calendar as a CSV. PostStack imports it through three public
API calls per post. Publishing itself has no additional plan gate, but this API-based migration requires a
plan with API access.

Create the API key with `channels:read`, `content:write`, and `posts:write`. Add `content:read` and
`posts:read` only if your importer also reads records back to verify the migration.

## 1. Export your calendar

| Tool | Where |
|------|-------|
| Buffer | Use the API export, or copy your queue into a CSV (Date, Time, Caption, Media URL, Channel). |
| Hootsuite | **Bulk Composer** uses a CSV with the same columns — export/keep that file. |
| Publer | Bulk scheduling works from a CSV; export the one you uploaded, or your queue. |
| SocialBee | Content is CSV-based; export your categories/queue. |
| Later | Export your calendar to CSV. |

> Tool UIs change. Confirm the exact export steps in your tool's current help docs before relying on them —
> we deliberately don't reproduce screenshots that go stale.

A typical exported row looks like:

```csv
Date,Time,Caption,Media URL,Channel
2026-07-01,09:30,"Summer launch is live! ",https://example.com/img1.jpg,Instagram
2026-07-02,17:00,"Behind the scenes ",https://example.com/img2.jpg,Facebook
```

## 2. Map a channel name to a PostStack channel id

List your connected channels and note the `id` you want each row to publish to:

```bash
curl -s https://your-instance/api/v1/channels \
  -H "Authorization: Bearer sk_live_your_key" | jq '.data[] | {id, platform, display_name}'
```

(Requires the `channels:read` scope.)

## 3. Import each post (three calls)

For every row:

**a. Create the editorial content** — `POST /api/v1/content` (body is camelCase; `title` is required):

```bash
curl -s -X POST https://your-instance/api/v1/content \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "title": "Summer launch is live!",
    "baseDescription": "Summer launch is live! ",
    "mediaUrls": ["https://example.com/img1.jpg"],
    "sourceRef": "buffer:row-1"
  }'
# → { "data": { "id": "<contentId>", ... } }
```

**b. Create the post** — `POST /api/v1/posts` (`platform` is required; `sourceRef` makes re-imports
idempotent — the same value is never inserted twice):

```bash
curl -s -X POST https://your-instance/api/v1/posts \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "contentId": "<contentId>",
    "platform": "instagram",
    "description": "Summer launch is live! ",
    "mediaUrls": ["https://example.com/img1.jpg"],
    "scheduledDate": "2026-07-01T09:30:00.000Z",
    "sourceRef": "buffer:row-1"
  }'
# → { "data": { "id": "<postId>", ... } }
```

**c. Schedule (or publish) it** — `POST /api/v1/posts/{postId}/publish`. Use `"when": "now"` to publish
immediately, or an ISO timestamp to schedule:

```bash
curl -s -X POST https://your-instance/api/v1/posts/<postId>/publish \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{ "channelId": "<channelId>", "when": "2026-07-01T09:30:00.000Z" }'
```

## Do it in one pass with the reference script

[`import-scheduled-posts.mjs`](import-scheduled-posts.mjs) reads a CSV and runs all three calls per row,
skipping rows that fail validation and reporting them. Plain Node 18+, no dependencies:

```bash
export POSTSTACK_URL="https://your-instance"
export POSTSTACK_KEY="sk_live_your_key"
export POSTSTACK_CHANNEL_ID="<channelId>"   # default channel for the import
node docs/migration/import-scheduled-posts.mjs path/to/your-export.csv
```

## Field mapping reference

| CSV column | PostStack field | Notes |
|------------|-----------------|-------|
| Caption / Message / Text | `description` (post) + `baseDescription` (content) | |
| Date + Time (+ Timezone) | `scheduledDate` | Combine and send as ISO 8601 **UTC**. |
| Platform / Channel | `platform` + `channelId` (at publish) | Map each unique value to a channel id. |
| Media URL / Image | `mediaUrls` (array) | Split multiple URLs on `,` or `\|`. |
| First Comment | `firstComment` | Instagram hashtag comment. |
| Hashtags | `hashtags` | |
| (generated) | `sourceRef` | Stable per row → re-running the import is safe (deduped). |

## Tips

- Convert local times to **UTC** before sending `scheduledDate`. A row whose time is in the past will be
  created but won't auto-publish — review those.
- The unique `sourceRef` per row means you can re-run the import after fixing a few rows without creating
  duplicates.
