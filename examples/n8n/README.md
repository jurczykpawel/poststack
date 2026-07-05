# n8n Integration Workflows

Ready-made n8n workflows that connect PostStack's outbound webhooks and REST API to the rest of your stack.

Each workflow ships in two languages - the logic is byte-identical, only the sticky-note text differs:

- `*.json` - English sticky notes
- `*-PL.json` - polskie sticky notes (node names and code stay English either way)

Import whichever file matches your preference (n8n → Workflows → Import from File).

> Outbound webhooks and API access are PostStack **Pro** features. Every delivery is HMAC-signed
> (`X-PostStack-Signature`, Stripe-style `t=...,v1=...`) and each workflow verifies the signature
> before trusting the payload.

## Save Instagram & Facebook DM leads to Google Sheets

**Files:** `dm-leads-to-google-sheets.json` / `dm-leads-to-google-sheets-PL.json`

PostStack's auto-reply rules can ask a contact for their email right inside an Instagram or Facebook DM (email capture). This workflow turns every captured lead into a row in a Google Sheet.

### What it does

1. Receives PostStack's signed `contact.created` / `contact.updated` webhook and verifies the `X-PostStack-Signature` HMAC header (replay-protected, supports secret rotation)
2. Acknowledges immediately (PostStack retries deliveries that don't get a 2xx), then drops non-contact events
3. Fetches the full contact from `GET /api/v1/contacts/{id}` - the event only carries the contact's id
4. Contacts with a captured email are appended or updated in your sheet (deduplicated by email); contacts without an email are skipped

### Setup

1. **Import workflow** - n8n → Workflows → Import from File → select `dm-leads-to-google-sheets.json` (or the `-PL` variant)
2. **In PostStack** open **Webhooks → Outbound webhooks**, add an endpoint with this workflow's Production URL (the **PostStack Webhook** node) and copy the signing secret
3. **Create an API key** in PostStack (**Settings → API keys**) with the `contacts:read` scope
4. **Edit the "Configuration (EDIT ME)" node**:
   - `postStackUrl` - your PostStack base URL
   - `apiKey` - the API key from step 3
   - `webhookSecret` - the endpoint signing secret from step 2
   - `googleSheetUrl`, `sheetTabName` - where leads should land
5. **Connect your Google account** on the **Save Lead to Google Sheets** node and add a header row: `Email, Name, Phone, Platform, Username, Captured at, Contact ID`
6. **Set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`** in your n8n environment and restart (needed by the **Verify Signature** node - see the red sticky note on the canvas)
7. **Activate the workflow** in n8n

### Customization

- **Different CRM** - swap the Google Sheets node for Listmonk, Mailchimp, Airtable or anything else; signature verification, event filtering and the contact fetch stay the same
- **More fields** - `GET /api/v1/contacts/{id}` also returns tags, subscription status and all connected channels

---

## Save Instagram & Facebook DM leads to Listmonk

**Files:** `dm-leads-to-listmonk.json` / `dm-leads-to-listmonk-PL.json`

Same lead pipeline as the Google Sheets variant, with a fully self-hosted sink: every captured email becomes a [Listmonk](https://listmonk.app) subscriber, with the platform, username and contact id stored as queryable attributes.

### Setup differences vs the Sheets variant

- In Listmonk create an API user (**Admin → Settings → Users**) and note the target list's id
- `Configuration (EDIT ME)` takes `listmonkUrl`, `listmonkUser`, `listmonkToken` and `listmonkListId` instead of the Google fields
- No n8n credentials needed - Listmonk is called with its native `token user:token` header
- Double opt-in stays on by default; flip `preconfirm_subscriptions` to `true` in **Add Subscriber to Listmonk** to skip the confirmation email; a 409 response means the subscriber already exists (safe)

---

## Comment→DM email capture (free ManyChat alternative)

**Files:** `comment-to-dm-leads-to-sheets.json` / `comment-to-dm-leads-to-sheets-PL.json`

The classic "comment GUIDE and I'll DM it to you" funnel. PostStack runs the whole loop natively - a rule replies to the comment, DMs the person and asks for their email with a native quick reply (one tap, Meta pre-fills the address). This workflow is the last mile: it saves every captured lead to a Google Sheet.

### Setup

Identical to the Sheets variant above, plus the PostStack rule:

1. **Rules** → new rule: trigger "comment contains keyword" (e.g. GUIDE), action = public reply + DM whose message includes an **Email quick reply**
2. Then follow the DM-leads Setup (webhook endpoint, API key, Configuration node, Google account, `NODE_FUNCTION_ALLOW_BUILTIN=crypto`)

Pair the rule with PostStack's follow-gate to require a follow before the DM goes out.

---

## Post alerts → Slack/Discord

**Files:** `post-alerts-to-chat.json` / `post-alerts-to-chat-PL.json`

Know the moment a scheduled post publishes, silently fails or gets held for a channel re-auth.

### What it does

1. Receives PostStack's signed post lifecycle webhook and verifies the `X-PostStack-Signature` header
2. Acknowledges immediately, routes `post.published` / `post.failed` / `post.held` to dedicated formatters
3. Pushes a readable one-line alert to any incoming-webhook chat: Slack, Discord (append `/slack` to its webhook URL), Mattermost, Rocket.Chat - no chat credentials needed in n8n

### Setup

1. **Import workflow** and add a PostStack outbound webhook endpoint with its Production URL (as above)
2. Create an incoming webhook in your chat tool → paste into `Configuration (EDIT ME)` as `chatWebhookUrl`
3. Fill in `postStackUrl` + `webhookSecret`, set `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, activate

### Customization

- Edit the three **Format** Code nodes for wording, links or @mentions on failures
- Add a 4th Switch rule for `post.unknown` to also catch indeterminate deliveries

---

## AI social media manager (trends → GPT → publish)

**Files:** `ai-social-media-manager.json` / `ai-social-media-manager-PL.json`

Every day: a trending topic from an RSS feed (Google Trends by default) → OpenAI writes a caption + hashtags in your brand voice (strict JSON) → one post per configured channel, created and published through the PostStack REST API. Every post ships with an image (config fallback; the feed item's picture wins when present).

### Setup

1. PostStack API key (**Settings → API keys**), channel ids from **Channels**
2. `Configuration (EDIT ME)`: `postStackUrl`, `apiKey`, `channelIds` (comma-separated), `topicFeedUrl`, `brandVoice`, `imageUrl`
3. Connect OpenAI credentials on **Write the Post**, adjust **Daily Trigger**, activate

---

## Google Sheets content calendar

**Files:** `sheets-content-calendar.json` / `sheets-content-calendar-PL.json`

A plain sheet (`Date | Text | Hashtags | ImageURL | Channels | Status | PostIDs | Error`) as your content calendar. Hourly, rows marked `ready` are resolved against the PostStack API (channels by id, @username or display name), created, scheduled for the row's date and written back in place as `scheduled` + post ids (or `error` + reason). Idempotent - re-runs never double-post; a failed row lands in its Error column instead of killing the run.

### Setup

1. Sheet tab with the header row above, rows marked `ready`
2. PostStack API key; `Configuration (EDIT ME)`: URL, key, sheet URL, tab name
3. Google credentials on both Sheets nodes, activate

---

## Blog RSS → social posts

**Files:** `blog-rss-to-social.json` / `blog-rss-to-social-PL.json`

Every new article in your blog's RSS/Atom feed becomes a social post: title + snippet + link, published to every configured channel. The feed trigger deduplicates on its own. Uses the article's own image when the feed provides one, your brand card otherwise.

### Setup

1. PostStack API key, channel ids; `Configuration (EDIT ME)`: URL, key, `channelIds`, `imageUrl`
2. Point **New Feed Item** at your feed, activate

Want an AI-written teaser instead of title+link? Drop an OpenAI node between **Build Caption** and **Get Channels** - the AI social media manager workflow shows the exact pattern.

---

## Drive videos → social posts

**Files:** `drive-videos-to-social.json` / `drive-videos-to-social-PL.json`

Drop a finished video into a Drive folder: the trigger fires, the file gets an anyone-with-link share (PostStack ingests it once and stores its own copy), OpenAI writes a caption + hashtags from the file name in your brand voice, and the video publishes to every configured channel. Chain a Whisper transcription step for transcript-based captions.

## AI image posts from trends

**Files:** `trends-ai-image-to-social.json` / `trends-ai-image-to-social-PL.json`

Trending topic (Google Trends RSS) → OpenAI writes caption + image prompt in your niche's style → `gpt-image-1` renders the visual → imgbb hosts it (free key; PostStack needs a public URL to ingest) → published to every configured channel. Swap imgbb for S3/R2 or the image call for Replicate/Flux - the only contract is a public image URL.

## Channel health alerts

**Files:** `channel-health-alerts.json` / `channel-health-alerts-PL.json`

Signed webhook → HMAC verify → `channel.needs_reauth` / `source.needs_reauth` / `source.data_access_expiring` become an attention alert with the reason and a reconnect link; `channel.reconnected` becomes a green all-clear. Same chat-webhook sink as the post-alerts workflow (Slack/Discord/Mattermost/Rocket.Chat, no credentials).

## Published posts → newsletter drafts

**Files:** `published-post-to-newsletter.json` / `published-post-to-newsletter-PL.json`

Every `post.published` event becomes a ready-to-edit **draft** campaign in Listmonk - the post text converted to HTML, subject from the first line, never auto-sent. Note: the event carries the delivery id; the workflow resolves it to the editorial post via `GET /api/v1/posts`.
