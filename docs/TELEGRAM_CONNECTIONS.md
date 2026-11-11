# Connecting Telegram

Telegram needs no developer app, OAuth client or review. You connect a **bot** by pasting its token.
Today a connected bot powers the **inbox**: private messages sent to the bot land in PostStack, and you
reply from there (manually, with rules or with sequences). The same bot can also publish scheduled posts to a channel or group (see [Publishing to a channel](#publishing-to-a-channel)).

## 1. Create the bot (2 minutes, in the Telegram app)

1. Open a chat with [@BotFather](https://t.me/BotFather) (check the blue verified badge).
2. Send `/newbot`.
3. Enter a display name, e.g. `Acme Support`.
4. Enter a username that ends with `bot`, e.g. `acme_support_bot`.
5. BotFather replies with a token that looks like `1234567890:AAH...`. Treat it like a password.

Optional, in the same chat: `/setuserpic` (avatar), `/setdescription` (text shown before a user starts the chat).

## 2. Connect it in PostStack

- **Dashboard:** Channels → Connect channel → Telegram → paste the token → Connect.
- **API:** `POST /api/v1/channels/telegram/connect` with `{"token": "<bot token>"}` (scope `channels:write`).

PostStack checks the token (`getMe`) and registers its webhook with a secret header, so incoming
messages are verified. Your instance must be reachable over public HTTPS at `APP_URL`.

## 3. Check it works

Open `https://t.me/<bot username>`, press **Start**, and send a message. It should appear in the Inbox
within seconds. Reply from PostStack and check that the reply arrives in Telegram.

## Publishing to a channel

1. In Telegram, open your channel → Administrators → add the bot as an administrator with **Post messages**
   (for a group, just add the bot as a member).
2. In PostStack open the channel (Channels → your Telegram bot) → **Publish to** → enter the channel
   `@username` (or the numeric chat id of a private channel) → Save.
   API: `PATCH /api/v1/channels/{id}` with `{"publish_target": "@my_channel"}` (scope `channels:write`).
   PostStack checks the bot's rights with Telegram and refuses with *"Add the bot as an administrator of the
   channel with permission to post messages"* if they are missing. Empty value turns publishing off.
3. Assign the channel to a brand, then pick Telegram in the composer. Without a target the composer shows a
   hint instead of a Telegram option.

Formats and limits (Bot API): text up to 4096 characters; photo, video or an album of 2–10 items with a
caption up to 1024 characters (on the first item of an album). Telegram downloads media from its public URL:
photos up to 5 MB, videos and other files up to 20 MB — larger files are not supported yet. Public channels get a
`https://t.me/<username>/<message_id>` link on the post; for an album the post keeps every message id
(`101,102,…`, first is the album's first message). Telegram flood control (HTTP 429) is retried after its `retry_after`.
Removing the bot from the channel makes publishing fail with a permission error (the channel itself stays connected).

## Pitfalls

- **One bot = one webhook.** Connecting a bot to PostStack replaces any webhook another tool
  (n8n, another bot framework) had set for it. Use a dedicated bot for PostStack.
- **Bots cannot message first.** A user has to start the chat with the bot before PostStack can reply.
- **Token regenerated or revoked in BotFather** (`/revoke`) → the channel shows *Needs reauth*.
  Paste the new token with Connect again.
- **Groups:** by default a bot in a group only sees commands and messages that mention it
  (privacy mode, `/setprivacy` in BotFather). The inbox is meant for private chats.

- **Video inside an album** must be served with a video content type (e.g. `video/mp4`). Telegram rejects a video URL that answers `application/octet-stream` inside an album (a single video post accepts it). PostStack media storage sets the right type; this matters for media hosted elsewhere.

## Guiding a customer (for agents)

The customer does steps 1.1–1.5 on their phone; you never need their Telegram login.
Ask them to paste the token only into the PostStack Connect form (never into chat or email),
then do step 3 together: they send a message to the bot, you confirm it in the Inbox.
If Connect fails with "Invalid bot token", ask them to copy the whole line from BotFather again,
including the part before the colon.
