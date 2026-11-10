# Connecting Telegram

Telegram needs no developer app, OAuth client or review. You connect a **bot** by pasting its token.
Today a connected bot powers the **inbox**: private messages sent to the bot land in PostStack, and you
reply from there (manually, with rules or with sequences). Publishing posts to a Telegram channel is planned.

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

## Pitfalls

- **One bot = one webhook.** Connecting a bot to PostStack replaces any webhook another tool
  (n8n, another bot framework) had set for it. Use a dedicated bot for PostStack.
- **Bots cannot message first.** A user has to start the chat with the bot before PostStack can reply.
- **Token regenerated or revoked in BotFather** (`/revoke`) → the channel shows *Needs reauth*.
  Paste the new token with Connect again.
- **Groups:** by default a bot in a group only sees commands and messages that mention it
  (privacy mode, `/setprivacy` in BotFather). The inbox is meant for private chats.

## Guiding a customer (for agents)

The customer does steps 1.1–1.5 on their phone; you never need their Telegram login.
Ask them to paste the token only into the PostStack Connect form (never into chat or email),
then do step 3 together: they send a message to the bot, you confirm it in the Inbox.
If Connect fails with "Invalid bot token", ask them to copy the whole line from BotFather again,
including the part before the colon.
