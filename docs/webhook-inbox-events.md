# Outgoing interface contract

What each receiver can rely on in order to act. Tests assert this contract, not the builder output.

## Every webhook event

Signed envelope: `id` (deduplicate on it), `type`, `created_at`, `data`. `data.id` identifies the
resource and `data.workspaceId` the workspace. Delivery is at least once and may arrive out of order.

## `post.*`

`data.id` is the post, `data.deliveryId` the delivery on one channel. Each event also carries
`channelId`, `platform` and `status`.

| Event | The receiver can | Extra fields |
| --- | --- | --- |
| `post.published` | link to the live post | `providerHandle`, `publishedAt`, `firstComment` `{ status, commentId, reason? }` |
| `post.failed` | show why and offer a new attempt | `reason`, `error` (same text) |
| `post.held` | ask a person to act | `reason`; `confirmationUrl` when the post must be confirmed again |
| `post.unknown` | check the platform before resending; the outcome could not be proven | `reason` |
| `post.first_comment` | follow the comment after publication | `status`, `commentId` or `reason` |

## `channel.*`

`channel.created`, `channel.reconnected` and `channel.needs_reauth` carry `data.id` (the channel),
`platform` and `displayName`. After `needs_reauth`, publishing to that channel waits until it is
reconnected. Error text and tokens are not included.

## `contact.created`, `contact.updated`

`data.id` is the contact. `channels` lists its identities as `{ channelId, platform, platformSenderId }`.
Read names and other details from `GET /api/v1/contacts/{data.id}`.

## `GET /api/v1/posts` delivery

Each post has `delivery`: `null` until it is scheduled, then `id`, `channelId`, `status`, `scheduledFor`,
`attempts`, `lastError` (secrets redacted), `platformPostId`, `updatedAt` and `firstComment`
`{ status, reason?, commentId, attempts, lastError }`.

## E-mail and alert webhook

Alerts go to one webhook, routed by `type`; e-mail is sent through that webhook's customized body. The body
offers `channel_id`, `source_id`, `workspace_id`, `platform`, `display_name`, `detail`, `expires_at`,
`days_left` and `app_url`, enough to name the channel and link to it. One alert per type and channel in 15 minutes.

# Contact erasure and conversation state events

Subscribe through `POST /api/v1/webhooks` with `event_types` set to
`["contact.erased", "conversation.updated"]`, or select these names in Webhooks →
Outgoing alert. An omitted or empty list subscribes to every event, including these two.

Both events use the existing signed envelope: `id` identifies the event for deduplication,
`type` selects the handler, `created_at` is the event timestamp, and `data.id` identifies
the resource. The mutation, event and dispatch job commit together. Delivery may be
retried; deduplicate by the envelope's `id`. See the [signature instructions](migration/from-manychat.md#6-stay-in-sync-with-your-other-tools-webhooks).

## `contact.erased`

The receiver can remove its local copy even though `GET /api/v1/contacts/{data.id}`
now returns 404. `data` contains:

| Field | Meaning |
| --- | --- |
| `id` | Stable PostStack contact ID captured before deletion. |
| `type` | `contact`. |
| `workspaceId` | Workspace owning the erased contact. |
| `channels` | All linked identities captured before deletion: `{ channelId, platform, platformSenderId }`. An unlinked contact has `[]`. |

Channel identity is a pair: use `channelId` together with `platformSenderId`. Sender
IDs alone are not globally unique. Names, email, phone and messages are not included.
A repeated DELETE that returns 404 produces no additional event.

## `conversation.updated`

The receiver can apply an Inbox state transition without fetching a newer version of
the conversation. `data` contains:

| Field | Meaning |
| --- | --- |
| `id`, `conversationId` | Stable PostStack conversation ID. |
| `type` | `conversation`. |
| `workspaceId`, `contactId`, `channelId` | Routing and resource correlation. |
| `previous`, `current` | Full state objects, each containing `status`, `is_automation_paused`, `assigned_to`. |
| `updatedAt` | UTC ISO timestamp captured during the state change. |

`status` is `open`, `closed` (shown as **Done** in Inbox), or `snoozed`.
`is_automation_paused` is a boolean. `assigned_to` is a workspace member's user ID
or `null`. A PATCH changing several fields produces one event. Unchanged values,
read receipts and rejected updates produce none. Incoming messages and comments that
reopen a closed or snoozed conversation produce a state event, including YouTube polling.
New-message activity on an already open conversation produces no state event. Old or
duplicate messages that do not change the state produce none either. Status and
automation changes made through Inbox use the same transactional state writer.

State changes on the same conversation are serialized when recorded. Webhook delivery
is asynchronous; receivers must tolerate duplicates and requests arriving out of order.
