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
read receipts and rejected updates produce none. New-message activity is outside
this event's scope. Status and automation changes made through Inbox use the same
transactional API operation.

State changes on the same conversation are serialized when recorded. Webhook delivery
is asynchronous; receivers must tolerate duplicates and requests arriving out of order.
