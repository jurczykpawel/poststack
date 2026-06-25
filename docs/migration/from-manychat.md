# Migrating from ManyChat (and Chatfuel)

ManyChat charges a subscription that grows with your contact count. PostStack is self-hosted: your
subscribers, tags, and automations live on your own server with no per-contact fee. This guide covers what
to bring over and how.

Migration from ManyChat has three parts:

1. **Subscribers & tags** — exportable as CSV, brought into your CRM.
2. **Automations / flows** — *not* exportable; rebuilt as PostStack rules & sequences (see
   [rebuild-automations.md](rebuild-automations.md)).
3. **Conversation history** — not migratable (ManyChat exports the current contact state, not full threads).

> The CRM (contacts & tags) is a **Pro** feature. The endpoints below require a Pro license.

## 1. Export your audience

In ManyChat (paid plans): **Audience tab → Export → CSV**. The file typically includes the Instagram
handle, email (if captured), tags, and any custom fields. ManyChat only stores the most recent opt-in
event, so you get the contact's current state, not its history.

> Confirm the current export steps in ManyChat's own help docs — their UI changes over time.

A typical row:

```csv
Name,Instagram Username,Email,Subscribed,Tags,City
Anna K,annak_design,anna@example.com,true,"customer,vip",Warsaw
```

## 2. Field mapping

| CSV column | PostStack target | Notes |
|------------|------------------|-------|
| Name | `contacts.display_name` | |
| Email | `contacts.email` | |
| Instagram Username / Handle | `contact_channels.platform_username` | Bound to the Instagram channel you pick. |
| Subscribed / Opt-in status | `contacts.is_subscribed` | |
| Tags (comma-separated) | `tags` + `contact_tags` | Tags are auto-created on import. |
| Any other column | `contacts.metadata` (JSON) | Custom fields are preserved as key/value. |

### A note on addressability

ManyChat exports the Instagram **handle**, not the numeric Instagram-scoped sender id that Meta requires to
send a DM. So an imported contact starts as a CRM record keyed by its handle; it becomes fully addressable
for auto-replies the first time it interacts with you (the inbound webhook matches the handle and fills in
the real sender id). Your tags, fields, and segments are intact from day one — outbound DM to a
never-interacted imported contact is the only thing that waits for that first touch.

## 3. Recreate your tags

Tags can be imported today via `POST /api/v1/tags` (`tags:write` scope, Pro):

```bash
curl -s -X POST https://your-instance/api/v1/tags \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{ "name": "vip", "color": "#6366f1" }'
```

## 4. Import the subscribers

Push the audience in with `POST /api/v1/contacts` (scope `contacts:write`, Pro). It accepts one contact or
an array (up to 1000 per request) and is idempotent — re-running updates instead of duplicating (dedup on
channel + handle), and `metadata` is merged so a re-import never clobbers existing custom fields:

```bash
curl -s -X POST https://your-instance/api/v1/contacts \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '[
    {
      "channel_id": "<your IG channel id>",
      "platform_username": "annak_design",
      "display_name": "Anna K",
      "email": "anna@example.com",
      "is_subscribed": true,
      "metadata": { "city": "Warsaw" },
      "tags": ["customer", "vip"]
    }
  ]'
# → { "data": { "created": 1, "updated": 0, "failed": 0, "results": [ { "index": 0, "status": "created", "contact_id": "…" } ] } }
```

Tags are created automatically; rows with an unknown channel are reported in `results` (not fatal).

### One pass with the reference script

[`import-contacts.mjs`](import-contacts.mjs) reads the audience CSV, maps the columns above (unknown
columns become `metadata`), and POSTs in batches:

```bash
export POSTSTACK_URL="https://your-instance"
export POSTSTACK_KEY="sk_live_your_key"
export POSTSTACK_CHANNEL_ID="<your IG channel id>"
node docs/migration/import-contacts.mjs path/to/audience.csv
```

## 5. Rebuild your automations

This is the part people worry about most, and it's usually quick. See
[rebuild-automations.md](rebuild-automations.md) for a side-by-side of common ManyChat flow patterns
(keyword → DM, comment → DM, story reply) and how to express each as a PostStack rule or sequence.
