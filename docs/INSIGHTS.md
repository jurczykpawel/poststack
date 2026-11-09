# Account Insights

Account Insights shows the statistics Instagram shares about a professional account, collected into your own database and read from there: the dashboard screen (**Insights**, `/insights`) and the REST API (`/api/v1/channels/{channelId}/insights…`) never call the platform when you open them. Collection runs in the existing worker process.

Insights is a **PRO** feature (the `insights` entitlement in the publishing area). One account (channel) is shown at a time; numbers of different accounts are never added together.

## What release A covers

| Covered | Not covered yet |
| --- | --- |
| Instagram **account** level, one metric: **Reach** per day | Per-post and Reel insights, Stories |
| Both Instagram logins (see below) | Audience demographics |
| Dashboard screen, REST API, local history | Facebook Page insights, YouTube, TikTok, LinkedIn, X |

The Reach request follows the platform's published documentation; confirming it against a real account that has granted the additional permission is still pending, so treat the first numbers on your instance as the check. Connecting Facebook for Instagram does not give you Facebook Page statistics. A metric with the same name on another platform will not necessarily mean the same thing; the catalog the API returns states each metric's definition.

## Requirements

- A PRO licence that includes the publishing area. Without it the screen shows a lock, the API answers `402`, nothing is collected and the app never asks for extra access.
- An Instagram **Business or Creator** account. Personal accounts have no account statistics; the channel then reports "This account does not provide account statistics".
- A channel connected through a login that can carry the statistics permission:

| Login | Host | Permissions Insights needs |
| --- | --- | --- |
| Instagram through Facebook Login (also a managed connection with a User token) | `graph.facebook.com` | `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` |
| Instagram Business Login | `graph.instagram.com` | `instagram_business_basic`, `instagram_business_manage_insights` |

A Page-only token cannot read account statistics. Each login keeps its own grant: giving access on one does not grant it on the other, and reconnecting a login re-checks it. See [Meta connections](META_CONNECTIONS.md#instagram-insights-and-the-two-logins) for which app roles and review status you need.

## Turn it on

Collection is **opt-in per channel** and off by default.

1. Open **Insights** and pick the channel.
2. Press **Turn on Insights**. The status becomes *Checking access* while a background check runs.
3. If the platform needs one more permission, the page says **Insights needs additional access** and offers **Grant Insights access**. That opens the platform's own login dialog asking only for the additional statistics permission. If you decline, press the button again later; the data you already collected stays and publishing and the Inbox keep working.
4. When access is confirmed the status is *Connected* and the first collection runs.

The API can switch collection on or off (`PATCH`), but granting access is always an interactive step in the dashboard.

## Statuses and what to do

| You see | Meaning | What to do |
| --- | --- | --- |
| Turn on Insights | Collection is off. Earlier data, if any, is shown. | Turn it on. |
| Collecting the first data | Access check or first collection in progress. | Wait a few minutes. The platform shares only recent days, so 30 days fill in over time. |
| Insights needs additional access | The login used for the channel lacks the statistics permission, or you declined it. | **Grant Insights access**. |
| Sign in again to keep collecting | The login used for Insights is no longer valid. | Reconnect the channel; publishing and Inbox report their own status on **Channels**. |
| This account does not provide account statistics | Not a professional account. | Switch the account type on Instagram. |
| Channel is paused | The channel is not active. | Reactivate the channel; collection resumes. |
| Showing data collected … Next attempt … | The platform is limiting requests or did not answer. | Nothing; it retries by itself. **Refresh** does not shorten this wait. |
| Collection looks delayed | No success for over 48 hours, or a first collection with no progress for over 15 minutes. | Check that the worker process is running. This is a hint, not a diagnosis. |
| No data for this period yet | Collection works but nothing is stored for the range. | Wait for the next collection; the platform can deliver data up to 48 hours late. |

## How to read the numbers

- **Provider day.** A day is the platform's reporting day and is shown unchanged in every browser time zone. For Instagram, this is the Pacific-time day the value covers; its date can appear one day earlier than in the Instagram app. Instagram's app can also show slightly different values. Only sync timestamps ("Last sync") follow the viewer's zone.
- **No data is not zero.** A day with no stored value is a gap (`null`, a break in the line, "—" in the table). `"0"` is a value the platform reported as zero and is a point on the axis.
- **Reach is not additive.** Unique people reached on different days overlap, so daily reach is never summed. The card for a 7 or 30 day range shows "—" and "Total not available for unique metrics" because no unique value for the whole range is stored (`unique_range_unavailable`). The chart and table show the daily values.
- **Provisional.** The platform can revise the last 48 hours; those days use a dashed line and are marked "(provisional)".
- **Partial.** A day whose start time is only estimated from the platform's end time is marked "(partial)". It stays visible but is left out of totals, so a total is never built from estimated boundaries.
- **Comparisons.** A percentage against the previous period appears only when both periods are complete and equal in length, and never when the previous value is 0.
- **Large numbers** are stored and returned as exact decimal strings; the table does not round them.

## Collection schedule and limits

- A sweep runs every 15 minutes; each channel is collected about once a day, spread by up to an hour.
- Each run re-reads the last 1, 2, 3 and 7 days to pick up platform corrections. History is backfilled in bounded steps up to 90 days, current days first, with at most 10 platform requests per run.
- At most 120 Insights requests per channel per 24 hours, shared by the schedule, backfill and refresh; at most two at once per instance and one per channel. Publishing and message sending take priority.
- After a failure the retry waits 1, 5, 15, then 60 minutes (with jitter), then the next cycle. A longer wait requested by the platform is always respected. When the platform reports high usage collection slows down and stops new requests.
- **Refresh** queues one run, at most once per 15 minutes per channel. It never publishes or sends anything.

## REST API

Authenticate with an API key. Reading needs `stats:read`; switching collection and refreshing need `channels:write`. Responses use the usual `{ data, error, meta }` shape and are listed in the OpenAPI spec at `/api/docs`.

```bash
CH=00000000-0000-4000-8000-000000000001   # your channel id

# status (never contacts the platform)
curl -H "Authorization: Bearer sk_live_…" "$APP_URL/api/v1/channels/$CH/insights"

# turn collection on
curl -X PATCH -H "Authorization: Bearer sk_live_…" -H "Content-Type: application/json" \
  -d '{"collectionMode":"on"}' "$APP_URL/api/v1/channels/$CH/insights"

# stored daily values: provider days [from, to), 1 to 90 days
curl -H "Authorization: Bearer sk_live_…" \
  "$APP_URL/api/v1/channels/$CH/insights/account?from=2026-11-01&to=2026-11-08&metrics=reach"

# queue a collection run
curl -X POST -H "Authorization: Bearer sk_live_…" "$APP_URL/api/v1/channels/$CH/insights/refresh"
```

- `from` and `to` are provider days; `to` is exclusive. The API accepts at most **90 days**; the dashboard offers 7 and 30.
- Every value is an exact decimal string (`"1504"`), never a JSON number. `"0"` is observed zero; `null` or a missing day is no data.
- `data.summary` gives per-metric totals only where they are valid. For reach `value` is `null` with `reason: "unique_range_unavailable"`.
- Series rows carry `provisional`, `partial` and `stale` flags, and `meta.coverage` repeats the requested days.
- Errors: `400` invalid range or metric, `402` PRO required, `404` channel not in this workspace, `422` platform without Insights, `429` for refresh while a cooldown or provider backoff is active (`Retry-After` and `error.details.next_retry_at` say when).

## What is stored, for how long, and what removes it

Account Insights are stored in your database, per workspace, and nowhere else. They are **not** part of the anonymous usage report (see [PRIVACY](PRIVACY.md)).

- Daily values are kept 400 days; range caches 7 days. Older rows are pruned automatically.
- Turning Insights **off** stops collection and keeps stored data until it expires.
- If the licence stops covering Insights, collection stops and the screen and API lock; stored data stays untouched and is shown again when the licence returns.
- Deleting the channel deletes its Insights data.

## For developers

Insights is a capability of the publishing `Provider` pattern, independent of publishing: a channel reports whether its platform supports it and, separately, whether it has access now. Metric semantics (label, unit, aggregation, chart) come from a per-platform catalog; storage, status, API and screen are shared, so another platform adds a connector and a catalog rather than tables.

- Contract and catalog: [`src/lib/insights/types.ts`](../src/lib/insights/types.ts), [`metric-catalog.ts`](../src/lib/insights/metric-catalog.ts), [`instagram/catalog.ts`](../src/lib/insights/instagram/catalog.ts)
- Collection: [`sync.ts`](../src/lib/insights/sync.ts), [`schedule.ts`](../src/lib/insights/schedule.ts); read model: [`service.ts`](../src/lib/insights/service.ts)
- Consent: [`consent.ts`](../src/lib/insights/consent.ts)
- API: [`src/server/handlers/v1`](../src/server/handlers/v1) and [`openapi.ts`](../src/lib/api/openapi.ts); screen: [`insights.ts`](../src/server/ui/sections/insights.ts)
- Vocabulary: [domain glossary](domain-glossary.md#insights)
