# Rebuilding your ManyChat automations in PostStack

ManyChat flows can't be exported as data, so you rebuild them — but the common patterns map cleanly onto
PostStack **rules** (single keyword → response) and **sequences** (multi-step drips). Most people port
their core automations in well under an hour.

Rules are created with `POST /api/v1/rules` (scope `rules:write`). Unlike the publishing API, the rules
body is **snake_case**. Browse the full schema interactively at `/api/docs`.

## Pattern map

| ManyChat flow | PostStack equivalent |
|---------------|----------------------|
| Keyword growth tool (DM a keyword → auto-reply) | Rule, `trigger_type: "keyword"` |
| Instagram comment automation (comment a word → DM) | Rule, `trigger_type: "comment_keyword"` |
| Story reply automation | Rule, `trigger_type: "story_reply"` |
| Welcome / default reply | Rule, `trigger_type: "welcome"` or `"default"` |
| Multi-step drip / nurture flow | Sequence + a rule with `response_type: "sequence"` |

## 1. Keyword → DM auto-reply

ManyChat: "when someone DMs **PRICE**, reply with the price list."

```bash
curl -s -X POST https://your-instance/api/v1/rules \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "name": "Price list",
    "trigger_type": "keyword",
    "trigger_config": { "keywords": [{ "value": "price", "match_type": "contains" }] },
    "response_type": "text",
    "response_config": { "text": "Here is our price list: https://example.com/pricing" },
    "cooldown_seconds": 60
  }'
```

`match_type` is `exact`, `contains`, or `starts_with`.

## 2. Comment → DM (Instagram comment automation)

ManyChat: "when someone comments **LINK** on a post, send them the link in a DM and reply publicly."

```bash
curl -s -X POST https://your-instance/api/v1/rules \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "name": "Comment LINK -> DM",
    "trigger_type": "comment_keyword",
    "trigger_config": {
      "keywords": [{ "value": "link", "match_type": "contains" }]
    },
    "response_type": "text",
    "response_config": {
      "reply_mode": "both",
      "text": "Here is the link you asked for: https://example.com",
      "comment_reply_text": "Just sent it to your DMs! "
    }
  }'
```

- `reply_mode`: `dm`, `comment`, or `both`.
- Scope it to a single post by adding `"post_id": "<media id>"` inside `trigger_config`.

## 3. Story reply automation

```bash
curl -s -X POST https://your-instance/api/v1/rules \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "name": "Story reply",
    "trigger_type": "story_reply",
    "trigger_config": { "keywords": [{ "value": "info", "match_type": "contains" }] },
    "response_type": "text",
    "response_config": { "text": "Thanks for replying to our story! " }
  }'
```

## 4. Multi-step drips → sequences

For a nurture flow with several messages over time, create a **sequence** (`POST /api/v1/sequences`,
scope `sequences:write`) with its steps, then either enroll contacts directly
(`POST /api/v1/sequences/{id}/enroll`) or have a rule enroll them on a trigger:

```bash
curl -s -X POST https://your-instance/api/v1/rules \
  -H "Authorization: Bearer sk_live_your_key" -H "Content-Type: application/json" \
  -d '{
    "name": "Lead magnet -> nurture",
    "trigger_type": "keyword",
    "trigger_config": { "keywords": [{ "value": "guide", "match_type": "contains" }] },
    "response_type": "sequence",
    "response_config": { "sequence_id": "<sequenceId>" }
  }'
```

## Useful options on any rule

- `cooldown_seconds` — minimum gap before the same contact can trigger this rule again.
- `max_sends_per_contact` — lifetime cap per contact (`null` = unlimited).
- `requires_approval` — hold the reply for human review before it sends.
- `channel_id` — limit the rule to one channel (`null`/omitted = all channels).
- `priority` — higher wins when multiple rules match.
